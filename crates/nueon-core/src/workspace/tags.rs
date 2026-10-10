//! Tag (column) management: add, edit type/format, remove.
use super::*;

impl Workspace {
    // -- tags -----------------------------------------------------------

    /// Add a column to a table.
    pub fn add_tag(&mut self, table: &str, tag: TagDef) -> Result<bool, StorageError> {
        let name = tag.name.clone();
        let exists = self
            .dictionary
            .table(table)
            .is_some_and(|t| t.has_tag(&name));
        if exists || self.dictionary.table(table).is_none() {
            return Ok(false);
        }
        self.record();
        self.dictionary.add_tag(table, tag);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: add tag \"{name}\" to table \"{table}\""),
        );
        Ok(true)
    }

    /// Every non-builtin tag name used across all tables, for suggestions.
    pub fn known_tag_names(&self) -> Vec<String> {
        self.dictionary.known_tag_names().into_iter().collect()
    }

    /// Change a tag's field type, migrating stored values where possible.
    pub fn set_tag_kind(
        &mut self,
        table: &str,
        tag: &str,
        kind: FieldType,
    ) -> Result<Option<TagKindChange>, StorageError> {
        self.record();
        let change = match self
            .dictionary
            .table_mut(table)
            .and_then(|t| t.set_tag_kind(tag, kind))
        {
            Some(change) => change,
            None => {
                self.history.undo.pop();
                return Ok(None);
            }
        };
        self.save_table(table)?;
        // Schema edits are committed immediately, like tag deletion, so a
        // type change is always a single revertible step in history. The
        // change is already saved, so a failed commit is best-effort.
        let _ = self.force_checkin(&format!(
            "nueon: change type of tag \"{tag}\" in table \"{table}\" to {:?} <CAN REVERT>",
            kind
        ));
        Ok(Some(change))
    }

    /// How many words would lose a value if `tag` were removed.
    pub fn preview_remove_tag(&self, table: &str, tag: &str) -> usize {
        self.dictionary.entries_with_tag(table, tag).len()
    }

    /// Set a tag's widget/format hint.
    pub fn set_tag_format(
        &mut self,
        table: &str,
        tag: &str,
        format: TagFormat,
    ) -> Result<bool, StorageError> {
        let exists = self.dictionary.table(table).is_some_and(|t| t.has_tag(tag));
        if !exists {
            return Ok(false);
        }
        self.record();
        self.dictionary
            .table_mut(table)
            .expect("checked above")
            .set_tag_format(tag, format);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: change format of tag \"{tag}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Set a tag's value-suggestion hint (whether its cells offer existing
    /// values). Returns `false` for an unknown table/tag.
    pub fn set_tag_suggest(
        &mut self,
        table: &str,
        tag: &str,
        suggest: bool,
    ) -> Result<bool, StorageError> {
        let exists = self.dictionary.table(table).is_some_and(|t| t.has_tag(tag));
        if !exists {
            return Ok(false);
        }
        self.record();
        self.dictionary
            .table_mut(table)
            .expect("checked above")
            .set_tag_suggest(tag, suggest);
        self.save_table(table)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: change suggestions of tag \"{tag}\" in table \"{table}\""),
        );
        Ok(true)
    }

    /// Remove a column, strip its values, and force a revertible check-in.
    ///
    /// The check-in is committed immediately (regardless of the auto-check-in
    /// toggle) so the destructive change can be reverted from the git panel.
    pub fn remove_tag(
        &mut self,
        table: &str,
        tag: &str,
    ) -> Result<Option<TagRemoval>, StorageError> {
        self.record();
        let removal = match self.dictionary.remove_tag(table, tag) {
            Some(removal) => removal,
            None => {
                self.history.undo.pop();
                return Ok(None);
            }
        };
        self.save_table(table)?;
        let message = format!(
            "nueon: DELETED TAGS: {table}.{tag} ({} words) <CAN REVERT>",
            removal.affected
        );
        let _ = self.force_checkin(&message);
        Ok(Some(removal))
    }
}
