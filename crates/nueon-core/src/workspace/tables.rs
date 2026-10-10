//! Table lifecycle: create, delete, rename, export and persist.
use super::*;

impl Workspace {
    // -- tables ---------------------------------------------------------

    /// Create a table and persist it.
    pub fn create_table(&mut self, name: &str) -> Result<bool, StorageError> {
        if self.dictionary.table(name).is_some() {
            return Ok(false);
        }
        self.table_files.resolve_new(name);
        self.record();
        self.dictionary.add_table(name);
        self.save_table(name)?;
        self.mark_change(Instant::now(), format!("nueon: create table \"{name}\""));
        Ok(true)
    }

    /// Delete a table by moving its file to the trash. Returns the trash
    /// record, or `None` if there is no such table.
    ///
    /// This is also an undoable dictionary step: Ctrl+Z brings the table back
    /// and drops the now-redundant trash copy, while the trash's own Restore
    /// is the route that survives a restart.
    pub fn delete_table(&mut self, name: &str) -> Result<Option<TrashRecord>, StorageError> {
        let Some(table) = self.dictionary.table(name).cloned() else {
            return Ok(None);
        };
        // The map, never a fresh slug: this is the one and only file this
        // table has ever been resolved to.
        let filename = self
            .table_files
            .filename(name)
            .map(str::to_string)
            .unwrap_or_else(|| self.table_files.resolve_new(name));
        let file = self.dictionary_dir().join(&filename);
        // Trash first: if it fails, memory and disk are both unchanged.
        let record = trash::trash_table(&self.root_path, &table, &file)?;
        self.record();
        self.dictionary.remove_table(name);
        self.table_files.remove(name);
        // Grid view state is presentation-only: drop it with the table. Table
        // roles, morpheme references and bound feature columns are *kept* so a
        // restored table heals; until then the editor flags them as broken.
        if self.settings.grid_views.remove(name).is_some() {
            self.save_settings()?;
        }
        self.mark_change(Instant::now(), format!("nueon: delete table \"{name}\""));
        Ok(Some(record))
    }

    /// Rename a table.
    ///
    /// The table keeps the exact file it already had — renaming only ever
    /// changes the `name` field inside that file. Earlier, a table's file was
    /// recomputed from its name on every save, so renaming a table to a name
    /// that slugifies the same way (`"Roots"` → `"roots"`, `"a b"` → `"a_b"`)
    /// silently deleted its own just-written file. Never recomputing avoids
    /// the whole class of bug.
    pub fn rename_table(&mut self, from: &str, to: &str) -> Result<bool, StorageError> {
        if from == to
            || to.trim().is_empty()
            || self.dictionary.table(from).is_none()
            || self.dictionary.table(to).is_some()
        {
            return Ok(false);
        }
        self.record();
        let mut table = self
            .dictionary
            .remove_table(from)
            .expect("existence checked above");
        table.name = to.to_string();
        self.dictionary.tables.insert(to.to_string(), table);
        self.table_files.rename(from, to);
        self.save_table(to)?;
        // Config that keyed the table by name (roles and morpheme references)
        // follows the rename, so designations and endings are not orphaned.
        self.rekey_table_references(from, to);
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        // Grid view state is keyed by table name too; keep it with the table.
        if let Some(view) = self.settings.grid_views.remove(from) {
            self.settings.grid_views.insert(to.to_string(), view);
            self.save_settings()?;
        }
        self.mark_change(
            Instant::now(),
            format!("nueon: rename table \"{from}\" to \"{to}\""),
        );
        Ok(true)
    }

    /// Point config that referenced a table by name at its new name: the
    /// table's role and any paradigm morpheme references.
    pub(crate) fn rekey_table_references(&mut self, from: &str, to: &str) {
        if let Some(config) = self.translation.table_roles.remove(from) {
            self.translation.table_roles.insert(to.to_string(), config);
        }
        for paradigm in &mut self.translation.morphology.paradigms {
            for row in &mut paradigm.rows {
                if let Some(MorphemeRef::Ref { table, .. }) = &mut row.morpheme {
                    if table == from {
                        *table = to.to_string();
                    }
                }
            }
        }
        for feature in &mut self.translation.morphology.features {
            if let Some(column) = &mut feature.column {
                if column.table == from {
                    column.table = to.to_string();
                }
            }
        }
    }

    /// Export a table to `destination` in the requested format (atomic write).
    pub fn export_table(
        &self,
        name: &str,
        format: TableFormat,
        destination: &Path,
    ) -> Result<(), StorageError> {
        let table = self
            .dictionary
            .table(name)
            .ok_or_else(|| StorageError::TableMissing(name.to_string()))?;
        let text = crate::export_table::export_table(table, format)
            .map_err(|err| StorageError::Config("export".into(), err.to_string()))?;
        storage::atomic_write(destination, text.as_bytes())
    }

    /// Export a table as an Anki-importable text file (atomic write).
    pub fn export_anki(
        &self,
        name: &str,
        options: &crate::export_table::AnkiExportOptions,
        destination: &Path,
    ) -> Result<(), StorageError> {
        let table = self
            .dictionary
            .table(name)
            .ok_or_else(|| StorageError::TableMissing(name.to_string()))?;
        let text = crate::export_table::export_anki(table, options);
        storage::atomic_write(destination, text.as_bytes())
    }

    /// Write a table to its already-resolved file.
    pub fn save_table(&mut self, name: &str) -> Result<(), StorageError> {
        let table = self
            .dictionary
            .table(name)
            .ok_or_else(|| StorageError::TableMissing(name.to_string()))?;
        let filename = match self.table_files.filename(name) {
            Some(filename) => filename.to_string(),
            None => self.table_files.resolve_new(name),
        };
        storage::write_table_file(&self.dictionary_dir().join(filename), table)
    }

    /// Persist in-place edits to the words of a table.
    pub fn save_table_edits(&mut self, table: &str) -> Result<(), StorageError> {
        self.save_table(table)?;
        self.mark_change(Instant::now(), format!("nueon: edit table \"{table}\""));
        Ok(())
    }
}
