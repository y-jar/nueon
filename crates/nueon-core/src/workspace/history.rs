//! Undo/redo snapshots and git-checkpoint diffing.

use super::*;

/// A note file whose contents a step changed, with its previous and new text.
#[derive(Debug, Clone)]
pub(crate) struct NoteEdit {
    pub(crate) path: PathBuf,
    pub(crate) before: String,
    pub(crate) after: String,
}

/// One undo/redo step: a dictionary snapshot plus the note files it rewrote.
#[derive(Debug)]
pub(crate) struct Step {
    pub(crate) dictionary: Dictionary,
    pub(crate) notes: Vec<NoteEdit>,
}

/// What an undo/redo applied, so the caller can notify the right slices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StepOutcome {
    /// Whether a step was applied at all.
    pub applied: bool,
    /// Whether the step rewrote note files on disk.
    pub notes: bool,
}

#[derive(Debug)]
pub(crate) struct History {
    pub(crate) undo: Vec<Step>,
    pub(crate) redo: Vec<Step>,
}

impl History {
    /// Maximum number of retained undo snapshots.
    const LIMIT: usize = 50;

    pub(crate) fn new() -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    pub(crate) fn record(&mut self, snapshot: Dictionary, notes: Vec<NoteEdit>) {
        self.undo.push(Step {
            dictionary: snapshot,
            notes,
        });
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub(crate) fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub(crate) fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

impl Workspace {
    // -- undo / redo ----------------------------------------------------

    /// Snapshot the dictionary before a mutation.
    pub(crate) fn record(&mut self) {
        self.history.record(self.dictionary.clone(), Vec::new());
    }

    /// Snapshot the dictionary and the note rewrites before a mutation.
    pub(crate) fn record_with_notes(&mut self, notes: Vec<NoteEdit>) {
        self.history.record(self.dictionary.clone(), notes);
    }

    /// Whether an undo step is available.
    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    /// Whether a redo step is available.
    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Restore the previous dictionary snapshot (and any notes it rewrote) and
    /// persist it.
    pub fn undo(&mut self) -> Result<StepOutcome, StorageError> {
        let Some(previous) = self.history.undo.pop() else {
            return Ok(StepOutcome::default());
        };
        // Touch the disk first: if that fails the snapshot goes back on the
        // stack and memory is unchanged.
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &previous.dictionary) {
            self.history.undo.push(previous);
            return Err(err);
        }
        let notes = !previous.notes.is_empty();
        for edit in &previous.notes {
            storage::write_existing_note(&self.notes_dir(), &edit.path, &edit.before, None)?;
        }
        let current = std::mem::replace(&mut self.dictionary, previous.dictionary);
        self.history.redo.push(Step {
            dictionary: current,
            notes: previous.notes,
        });
        self.mark_change(Instant::now(), "nueon: undo");
        Ok(StepOutcome {
            applied: true,
            notes,
        })
    }

    /// Re-apply the next dictionary snapshot (and any note rewrites) and
    /// persist it.
    pub fn redo(&mut self) -> Result<StepOutcome, StorageError> {
        let Some(next) = self.history.redo.pop() else {
            return Ok(StepOutcome::default());
        };
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &next.dictionary) {
            self.history.redo.push(next);
            return Err(err);
        }
        let notes = !next.notes.is_empty();
        for edit in &next.notes {
            storage::write_existing_note(&self.notes_dir(), &edit.path, &edit.after, None)?;
        }
        let current = std::mem::replace(&mut self.dictionary, next.dictionary);
        self.history.undo.push(Step {
            dictionary: current,
            notes: next.notes,
        });
        self.mark_change(Instant::now(), "nueon: redo");
        Ok(StepOutcome {
            applied: true,
            notes,
        })
    }

    /// Bring the table files in line with a restored snapshot by touching
    /// **only the tables that differ** between `before` and `after`.
    ///
    /// Undo and redo own exactly the table files the app has written. They
    /// never list `dictionary/`, so a README, a `.tmp` leftover, a hand-edited
    /// table they did not change, or any other file is left strictly alone.
    /// Filenames are never recomputed: an unchanged name reuses its existing
    /// file, and a name reappearing after a delete resolves a fresh one only
    /// because its old mapping was released when it was removed.
    pub(crate) fn write_dictionary_diff(
        &mut self,
        before: &Dictionary,
        after: &Dictionary,
    ) -> Result<(), StorageError> {
        let dir = self.dictionary_dir();
        for table in after.tables() {
            if before.table(&table.name) != Some(table) {
                let filename = match self.table_files.filename(&table.name) {
                    Some(filename) => filename.to_string(),
                    None => self.table_files.resolve_new(&table.name),
                };
                storage::write_table_file(&dir.join(filename), table)?;
                // Brought back: a trash copy of this exact table is redundant.
                trash::consume_table(&self.root_path, table);
            }
        }
        for table in before.tables() {
            if after.table(&table.name).is_none() {
                let Some(filename) = self.table_files.remove(&table.name) else {
                    continue;
                };
                // An empty table undone/redone away (typically straight after
                // its own creation) is not worth a trash entry: there is
                // nothing in it to lose, and it would otherwise clutter the
                // trash on every "create table" + Ctrl+Z.
                if table.entries.is_empty() {
                    let _ = storage::remove_silently(&dir.join(&filename));
                    continue;
                }
                // Even undo/redo never deletes a table file outright: it goes
                // to the trash, where it can still be restored.
                let file = dir.join(&filename);
                trash::trash_table(&self.root_path, table, &file)?;
            }
        }
        Ok(())
    }
}
