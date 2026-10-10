//! Undo/redo snapshots and git-checkpoint diffing.

use super::*;

#[derive(Debug)]
pub(crate) struct History {
    pub(crate) undo: Vec<Dictionary>,
    pub(crate) redo: Vec<Dictionary>,
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

    pub(crate) fn record(&mut self, snapshot: Dictionary) {
        self.undo.push(snapshot);
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
        self.history.record(self.dictionary.clone());
    }

    /// Whether an undo step is available.
    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    /// Whether a redo step is available.
    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Restore the previous dictionary snapshot and persist it.
    pub fn undo(&mut self) -> Result<bool, StorageError> {
        let Some(previous) = self.history.undo.pop() else {
            return Ok(false);
        };
        // Touch the disk first: if that fails the snapshot goes back on the
        // stack and memory is unchanged.
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &previous) {
            self.history.undo.push(previous);
            return Err(err);
        }
        let current = std::mem::replace(&mut self.dictionary, previous);
        self.history.redo.push(current);
        self.mark_change(Instant::now(), "nueon: undo");
        Ok(true)
    }

    /// Re-apply the next dictionary snapshot and persist it.
    pub fn redo(&mut self) -> Result<bool, StorageError> {
        let Some(next) = self.history.redo.pop() else {
            return Ok(false);
        };
        let before = self.dictionary.clone();
        if let Err(err) = self.write_dictionary_diff(&before, &next) {
            self.history.redo.push(next);
            return Err(err);
        }
        let current = std::mem::replace(&mut self.dictionary, next);
        self.history.undo.push(current);
        self.mark_change(Instant::now(), "nueon: redo");
        Ok(true)
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
