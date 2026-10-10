//! Notes, folders and assets.

use super::*;

impl Workspace {
    /// Persist a note's raw content and refresh the in-memory copy.
    pub fn save_note(&mut self, note: &NoteFile) -> Result<(), StorageError> {
        self.save_note_checked(note, None).map(|_| ())
    }

    /// Overwrite an existing note, refusing if it changed on disk since
    /// `base_hash` was taken. Returns the new content hash.
    pub fn save_note_checked(
        &mut self,
        note: &NoteFile,
        base_hash: Option<&str>,
    ) -> Result<String, StorageError> {
        let (hash, wrote) = storage::write_existing_note(
            &self.notes_dir(),
            &note.path,
            &note.raw_content,
            base_hash,
        )?;
        if wrote {
            match self.notes.iter_mut().find(|n| n.path == note.path) {
                Some(existing) => *existing = note.clone(),
                None => self.notes.push(note.clone()),
            }
            self.mark_change(
                Instant::now(),
                format!("nueon: update note \"{}\"", note.path.display()),
            );
        }
        Ok(hash)
    }

    /// A note's content together with its hash (the base for later saves).
    pub fn read_note_snapshot(
        &self,
        relative: impl AsRef<Path>,
    ) -> Result<(String, String), StorageError> {
        storage::read_note_snapshot(&self.notes_dir(), relative.as_ref())
    }

    /// Copy an external file into `notes/assets/` under a readable name.
    pub fn import_asset(
        &mut self,
        source: impl AsRef<Path>,
    ) -> Result<ImportedAsset, StorageError> {
        let imported = assets::import_asset(&self.notes_dir(), source.as_ref())?;
        if !imported.existed {
            self.mark_change(
                Instant::now(),
                format!("nueon: import asset \"{}\"", imported.name),
            );
        }
        Ok(imported)
    }

    /// Copy an external file into `folder` of `notes/`, keeping its own name.
    /// Returns the new path relative to `notes/`.
    pub fn copy_file_into(
        &mut self,
        folder: impl AsRef<Path>,
        source: impl AsRef<Path>,
    ) -> Result<PathBuf, StorageError> {
        let relative = storage::copy_into(&self.notes_dir(), folder.as_ref(), source.as_ref())?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("nueon: add file \"{}\"", relative.display()),
        );
        Ok(relative)
    }

    /// Read a note's raw content from `notes/<relative>`.
    pub fn read_note(&self, relative: impl AsRef<Path>) -> Result<String, StorageError> {
        storage::read_note(&self.notes_dir(), relative.as_ref())
    }

    /// Create an empty note and refresh the note list. A name without an
    /// extension gets `.md`; the final relative path is returned.
    pub fn create_note(&mut self, relative: impl AsRef<Path>) -> Result<PathBuf, StorageError> {
        let relative = storage::with_note_extension(relative.as_ref());
        storage::create_note(&self.notes_dir(), &relative)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("nueon: create note \"{}\"", relative.display()),
        );
        Ok(relative)
    }

    /// Create a new note holding `content`. Like [`Workspace::create_note`] it
    /// refuses to overwrite anything and returns the final path.
    pub fn create_note_with_content(
        &mut self,
        relative: impl AsRef<Path>,
        content: &str,
    ) -> Result<PathBuf, StorageError> {
        let created = self.create_note(relative)?;
        self.save_note(&NoteFile::new(&created, content))?;
        Ok(created)
    }

    /// Create a notes folder.
    pub fn create_folder(&mut self, relative: impl AsRef<Path>) -> Result<(), StorageError> {
        let relative = relative.as_ref();
        storage::create_folder(&self.notes_dir(), relative)?;
        self.mark_change(
            Instant::now(),
            format!("nueon: create folder \"{}\"", relative.display()),
        );
        Ok(())
    }

    /// Rename a note or folder and refresh the note list.
    pub fn rename_note(
        &mut self,
        from: impl AsRef<Path>,
        to: impl AsRef<Path>,
    ) -> Result<PathBuf, StorageError> {
        let from = from.as_ref();
        let to = storage::rename_path(&self.notes_dir(), from, to.as_ref())?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!(
                "nueon: rename \"{}\" to \"{}\"",
                from.display(),
                to.display()
            ),
        );
        Ok(to)
    }

    /// Delete a note or folder by moving it to the trash (nothing is ever
    /// removed outright). Returns the trash record for Undo/Restore.
    pub fn delete_note(&mut self, relative: impl AsRef<Path>) -> Result<TrashRecord, StorageError> {
        let relative = relative.as_ref();
        if relative.as_os_str().is_empty() {
            return Err(StorageError::UnsafePath(relative.to_path_buf()));
        }
        let source = storage::safe_join(&self.notes_dir(), relative)?;
        let meta = std::fs::symlink_metadata(&source)
            .map_err(|_| StorageError::NotFound(relative.to_path_buf()))?;
        let (kind, count) = if meta.is_dir() {
            (TrashKind::Folder, trash::count_files(&source))
        } else {
            (TrashKind::Note, 1)
        };
        let original = relative
            .to_string_lossy()
            .replace('\\', "/")
            .trim_matches('/')
            .to_string();
        let record = trash::trash_path(&self.root_path, &source, kind, original, count)?;
        self.refresh_notes()?;
        self.mark_change(
            Instant::now(),
            format!("nueon: delete \"{}\"", relative.display()),
        );
        Ok(record)
    }

    /// How many files a note path covers (1 for a note, N for a folder); used
    /// by the delete confirmation.
    pub fn count_notes(&self, relative: impl AsRef<Path>) -> Result<usize, StorageError> {
        let source = storage::safe_join(&self.notes_dir(), relative.as_ref())?;
        Ok(trash::count_files(&source))
    }

    pub(crate) fn refresh_notes(&mut self) -> Result<(), StorageError> {
        self.notes = storage::scan_notes(&self.notes_dir())?;
        Ok(())
    }
}
