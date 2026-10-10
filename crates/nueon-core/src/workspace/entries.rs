//! Word entries: create, edit, classify, parents and delete.
use super::*;

impl Workspace {
    // -- words ----------------------------------------------------------

    /// Create and persist a new word in a table.
    pub fn create_entry(
        &mut self,
        table: &str,
        wordname: impl Into<String>,
    ) -> Result<Option<Uuid>, StorageError> {
        if self.dictionary.table(table).is_none() {
            return Ok(None);
        }
        self.record();
        let entry = WordEntry::new(wordname);
        let id = entry.id;
        let wordname = entry.wordname.clone();
        self.dictionary.add_entry(table, entry);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: add word \"{wordname}\" to table \"{table}\""),
        );
        Ok(Some(id))
    }

    /// Create a word with an English definition and optional tags.
    ///
    /// Tags that are not yet columns in the table are declared as Boolean
    /// columns. Used by the translation view's inline missing-word creation.
    pub fn create_defined_entry(
        &mut self,
        table: &str,
        wordname: impl Into<String>,
        definition: &str,
        tags: &[String],
    ) -> Result<Option<Uuid>, StorageError> {
        if self.dictionary.table(table).is_none() {
            return Err(StorageError::TableMissing(table.to_string()));
        }
        self.record();
        for tag in tags {
            let declared = self.dictionary.table(table).is_some_and(|t| t.has_tag(tag));
            if !declared {
                self.dictionary
                    .add_tag(table, TagDef::new(tag.clone(), FieldType::Boolean));
            }
        }

        let mut entry = WordEntry::new(wordname);
        let id = entry.id;
        if !definition.trim().is_empty() {
            entry.set(
                DEFINITION_TAG,
                FieldValue::TagList(vec![definition.trim().to_string()]),
            );
        }
        for tag in tags {
            entry.set(tag, FieldValue::Boolean(true));
        }
        let wordname = entry.wordname.clone();
        self.dictionary.add_entry(table, entry);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: add word \"{wordname}\" (from translation) to table \"{table}\""),
        );
        Ok(Some(id))
    }

    /// Set a word's class (`pos`), declaring the tag as a list column when it
    /// is not yet present. `None` clears the word's class.
    pub fn set_class(
        &mut self,
        table: &str,
        id: Uuid,
        class: Option<&str>,
    ) -> Result<bool, StorageError> {
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(false);
        }
        let column = self.class_column();
        match class.map(str::trim).filter(|value| !value.is_empty()) {
            Some(class) => {
                let declared = self
                    .dictionary
                    .table(table)
                    .is_some_and(|t| t.has_tag(&column));
                if !declared {
                    self.dictionary
                        .add_tag(table, TagDef::new(column.clone(), FieldType::TagList));
                }
                self.set_value(
                    table,
                    id,
                    &column,
                    Some(FieldValue::TagList(vec![class.to_string()])),
                )
            }
            None => self.set_value(table, id, &column, None),
        }
    }

    /// The column holding each word's class: configured, else auto-detected.
    pub fn class_column(&self) -> String {
        crate::model::translate::class_column(&self.dictionary, &self.translation.morphology)
    }

    /// Strip a leading `#` from `column`'s values in every table, so a `#noun`
    /// flag reads as the class `noun`. Undoable and git-checkpointed.
    pub fn normalize_class_values(&mut self, column: &str) -> Result<usize, StorageError> {
        let hashed = |value: &FieldValue| match value {
            FieldValue::Text(text) => text.starts_with('#'),
            FieldValue::TagList(list) => list.iter().any(|item| item.starts_with('#')),
            _ => false,
        };
        let needs = self.dictionary.tables().any(|table| {
            table
                .entries
                .iter()
                .any(|entry| entry.values.get(column).is_some_and(hashed))
        });
        if !needs {
            return Ok(0);
        }
        self.record();

        let names: Vec<String> = self.dictionary.tables().map(|t| t.name.clone()).collect();
        let mut touched: Vec<String> = Vec::new();
        let mut changed = 0usize;
        for name in names {
            let mut table_changed = false;
            if let Some(table) = self.dictionary.tables.get_mut(&name) {
                for entry in &mut table.entries {
                    if let Some(value) = entry.values.get_mut(column) {
                        let stripped = match value {
                            FieldValue::Text(text) => match text.strip_prefix('#') {
                                Some(rest) => {
                                    *text = rest.to_string();
                                    true
                                }
                                None => false,
                            },
                            FieldValue::TagList(list) => {
                                let mut any = false;
                                for item in list.iter_mut() {
                                    if let Some(rest) = item.strip_prefix('#') {
                                        *item = rest.to_string();
                                        any = true;
                                    }
                                }
                                any
                            }
                            _ => false,
                        };
                        if stripped {
                            changed += 1;
                            table_changed = true;
                        }
                    }
                }
            }
            if table_changed {
                touched.push(name);
            }
        }

        for name in &touched {
            self.save_table(name)?;
        }
        self.mark_change(
            Instant::now(),
            format!("nueon: clean '#' from \"{column}\" ({changed})"),
        );
        Ok(changed)
    }

    /// Persist an existing word after it has been edited.
    pub fn save_entry(&mut self, table: &str, id: Uuid) -> Result<bool, StorageError> {
        let wordname = match self.dictionary.get_entry(table, id) {
            Some(entry) => entry.wordname.clone(),
            None => return Ok(false),
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: update word \"{wordname}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Replace an existing word's data and persist it.
    ///
    /// This overwrites every field at once from a caller-supplied snapshot.
    /// Two editors (the grid and the inspector, say) each hold their own
    /// snapshot of a word; if both call this, whichever save lands second
    /// **silently discards** the first save's change to any field it did
    /// not itself touch, because from its point of view that field was
    /// never different from the stale snapshot it started from. Prefer
    /// [`Self::set_value`], [`Self::set_definition`] and
    /// [`Self::rename_word`], which patch one field against whatever is
    /// *currently* stored and so can never clobber a concurrent edit to a
    /// different field. This is kept for callers that genuinely do have a
    /// fresh, complete entry to write (for example, creating one).
    pub fn replace_entry(&mut self, table: &str, entry: WordEntry) -> Result<bool, StorageError> {
        let id = entry.id;
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(false);
        }
        self.record();
        if let Some(existing) = self.dictionary.get_entry_mut(table, id) {
            *existing = entry;
        }
        self.save_entry(table, id)
    }

    /// Apply one field's value to a word, leaving every other field as it
    /// currently is on the in-memory dictionary (the single source of
    /// truth). `None` removes the tag. Rejects `tag == "wordname"` — use
    /// [`Self::rename_word`] for that — and rejects an unknown table/word.
    ///
    /// Because this always reads and writes against *current* data rather
    /// than a snapshot the caller might be holding stale, two patches to
    /// different fields of the same word can never clobber each other no
    /// matter which order they land in.
    pub fn set_value(
        &mut self,
        table: &str,
        id: Uuid,
        tag: &str,
        value: Option<FieldValue>,
    ) -> Result<bool, StorageError> {
        if tag == WORDNAME_TAG {
            return Ok(false);
        }
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(false);
        }
        self.record();
        if let Some(entry) = self.dictionary.get_entry_mut(table, id) {
            match value {
                Some(value) => {
                    entry.set(tag, value);
                }
                None => {
                    entry.remove(tag);
                }
            }
        }
        self.save_entry(table, id)
    }

    /// Apply one field's value to many words at once, as a **single** undo
    /// checkpoint and a single file write. Ids not in the table are skipped;
    /// `wordname` is rejected like [`Self::set_value`]. Returns how many words
    /// were changed.
    pub fn set_values(
        &mut self,
        table: &str,
        ids: &[Uuid],
        tag: &str,
        value: Option<FieldValue>,
    ) -> Result<usize, StorageError> {
        if tag == WORDNAME_TAG || self.dictionary.table(table).is_none() {
            return Ok(0);
        }
        let present: Vec<Uuid> = ids
            .iter()
            .copied()
            .filter(|id| self.dictionary.get_entry(table, *id).is_some())
            .collect();
        if present.is_empty() {
            return Ok(0);
        }
        self.record();
        for id in &present {
            if let Some(entry) = self.dictionary.get_entry_mut(table, *id) {
                match &value {
                    Some(value) => entry.set(tag, value.clone()),
                    None => entry.remove(tag),
                };
            }
        }
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!(
                "nueon: set \"{tag}\" on {} words in \"{table}\"",
                present.len()
            ),
        );
        Ok(present.len())
    }

    /// Set (or, if empty, remove) a word's `definition` senses. Sugar over
    /// [`Self::set_value`] for the one tag editors treat specially.
    pub fn set_definition(
        &mut self,
        table: &str,
        id: Uuid,
        senses: Vec<String>,
    ) -> Result<bool, StorageError> {
        let value = (!senses.is_empty()).then_some(FieldValue::TagList(senses));
        self.set_value(table, id, DEFINITION_TAG, value)
    }

    /// Rename a word (its `wordname` field) without touching any other
    /// field, so it cannot clobber a concurrent edit the way sending a whole
    /// stale entry through [`Self::replace_entry`] could.
    ///
    /// Every `[[old]]` / `[[old|alias]]` / `![[old]]` link in the workspace's
    /// notes is rewritten to the new name (case-insensitively), and the whole
    /// rename is one undo step.
    pub fn rename_word(
        &mut self,
        table: &str,
        id: Uuid,
        wordname: impl Into<String>,
    ) -> Result<bool, StorageError> {
        let new = wordname.into();
        let old = match self.dictionary.get_entry(table, id) {
            Some(entry) => entry.wordname.clone(),
            None => return Ok(false),
        };
        if old == new {
            return Ok(false);
        }
        let mut notes = Vec::new();
        for note in &self.notes {
            let content = storage::read_note(&self.notes_dir(), &note.path)?;
            let rewritten = links::rewrite_links(&content, &old, &new);
            if rewritten != content {
                notes.push(history::NoteEdit {
                    path: note.path.clone(),
                    before: content,
                    after: rewritten,
                });
            }
        }
        self.record_with_notes(notes.clone());
        if let Some(entry) = self.dictionary.get_entry_mut(table, id) {
            entry.wordname = new;
        }
        self.save_entry(table, id)?;
        for edit in &notes {
            storage::write_existing_note(&self.notes_dir(), &edit.path, &edit.after, None)?;
        }
        Ok(true)
    }

    /// Move a word to another table and persist both tables.
    pub fn move_entry(&mut self, from: &str, to: &str, id: Uuid) -> Result<bool, StorageError> {
        if from == to
            || self.dictionary.table(to).is_none()
            || self.dictionary.get_entry(from, id).is_none()
        {
            return Ok(false);
        }
        self.record();
        self.dictionary.move_entry(from, to, id);
        self.save_table(from)?;
        self.save_table(to)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: move word between \"{from}\" and \"{to}\""),
        );
        Ok(true)
    }

    /// Add a parent link (rejecting cycles) and persist the table.
    pub fn add_parent(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if !self.dictionary.can_be_parent(child, parent)
            || self.dictionary.get_entry(table, child).is_none()
        {
            return Ok(false);
        }
        self.record();
        self.dictionary.add_parent(table, child, parent);
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Remove a parent link and persist the table.
    pub fn remove_parent(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if self.dictionary.get_entry(table, child).is_none() {
            return Ok(false);
        }
        self.record();
        if !self.dictionary.remove_parent(table, child, parent) {
            self.history.undo.pop();
            return Ok(false);
        }
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Replace a word's parents with the single given parent, in one step.
    ///
    /// Rejects cycles (the parent may not be the word or its descendant).
    pub fn set_parent_only(
        &mut self,
        table: &str,
        child: Uuid,
        parent: Uuid,
    ) -> Result<bool, StorageError> {
        if !self.dictionary.can_be_parent(child, parent) {
            return Ok(false);
        }
        if self.dictionary.get_entry(table, child).is_none() {
            return Ok(false);
        }
        self.record();
        if let Some(entry) = self.dictionary.get_entry_mut(table, child) {
            entry.set_parents(&[parent]);
        }
        self.save_table_edits(table)?;
        Ok(true)
    }

    /// Remove a word from its table and persist the change.
    pub fn delete_entry(
        &mut self,
        table: &str,
        id: Uuid,
    ) -> Result<Option<WordEntry>, StorageError> {
        if self.dictionary.get_entry(table, id).is_none() {
            return Ok(None);
        }
        self.record();
        let removed = match self.dictionary.remove_entry(table, id) {
            Some(entry) => entry,
            None => return Ok(None),
        };
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!(
                "nueon: delete word \"{}\" from table \"{table}\"",
                removed.wordname
            ),
        );
        Ok(Some(removed))
    }

    /// Delete a word, handling the words that derive from it. With
    /// `cascade`, the whole descendant subtree goes too; otherwise each direct
    /// child is either moved to the replacement parent chosen in
    /// `reassignments` (guarded against cycles and against the deleted word)
    /// or left parentless. One undo checkpoint for the whole operation.
    /// Returns how many words were removed.
    pub fn delete_entry_with(
        &mut self,
        table: &str,
        id: Uuid,
        reassignments: &BTreeMap<Uuid, Option<Uuid>>,
        cascade: bool,
    ) -> Result<usize, StorageError> {
        let Some(wordname) = self
            .dictionary
            .get_entry(table, id)
            .map(|e| e.wordname.clone())
        else {
            return Ok(0);
        };
        self.record();

        let mut touched: BTreeSet<String> = BTreeSet::new();
        let mut removed = 0usize;

        if cascade {
            // Remove the word and every word that descends from it.
            let subtree: Vec<(String, Uuid)> = self
                .dictionary
                .descendants_of(id)
                .into_iter()
                .filter_map(|entry| {
                    self.dictionary
                        .find_entry(entry.id)
                        .map(|(name, _)| (name.to_string(), entry.id))
                })
                .collect();
            for (name, entry_id) in subtree {
                if self.dictionary.remove_entry(&name, entry_id).is_some() {
                    touched.insert(name);
                    removed += 1;
                }
            }
            self.dictionary.remove_entry(table, id);
            touched.insert(table.to_string());
            removed += 1;
        } else {
            // Re-parent or orphan each direct child, then remove the word.
            for child in crate::model::derivation::direct_children(&self.dictionary, id) {
                if let Some(entry) = self.dictionary.get_entry_mut(&child.table, child.id) {
                    entry.remove_parent(id);
                }
                touched.insert(child.table.clone());
                if let Some(Some(parent)) = reassignments.get(&child.id).copied() {
                    if parent != id && self.dictionary.can_be_parent(child.id, parent) {
                        if let Some(entry) = self.dictionary.get_entry_mut(&child.table, child.id) {
                            entry.add_parent(parent);
                        }
                    }
                }
            }
            self.dictionary.remove_entry(table, id);
            touched.insert(table.to_string());
            removed += 1;
        }

        for name in &touched {
            self.save_table(name)?;
        }
        let suffix = if cascade { " and its dependents" } else { "" };
        self.mark_change(
            Instant::now(),
            format!("nueon: delete word \"{wordname}\"{suffix} from table \"{table}\""),
        );
        Ok(removed)
    }
}
