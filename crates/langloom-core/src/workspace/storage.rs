//! Extensionless, plain-file persistence for a workspace.
//!
//! Each word table is stored as one JSON file under `dictionary/<slug>`, the
//! user's Markdown notes live under `notes/<relative path>` verbatim, and
//! per-conlang configuration lives under `config/<name>`. All writes are
//! atomic (temp file + rename) so a crash cannot leave a half-written file.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::model::WordTable;
use crate::workspace::NoteFile;

/// Directory holding raw Markdown notes.
pub const NOTES_DIR: &str = "notes";
/// Directory holding one JSON file per word table.
pub const DICTIONARY_DIR: &str = "dictionary";
/// Directory holding per-conlang configuration.
pub const CONFIG_DIR: &str = "config";

/// `config/` file holding language metadata.
pub const LANGUAGE_FILE: &str = "language";
/// `config/` file holding grammar rules.
pub const GRAMMAR_FILE: &str = "grammar";
/// `config/` file holding translation configuration.
pub const TRANSLATION_FILE: &str = "translation";
/// `config/` file holding workspace settings.
pub const SETTINGS_FILE: &str = "settings";

/// Extension given to notes created without one.
pub const NOTE_EXT: &str = "md";

/// Whether `ext` plausibly is a file extension (short, alphanumeric), as
/// opposed to the tail of a name like `v1.2 notes`.
fn looks_like_extension(ext: &str) -> bool {
    !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Whether the final component of `path` carries a real extension.
pub fn has_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(looks_like_extension)
}

/// `relative` with `.md` appended when it has no extension.
pub fn with_note_extension(relative: &Path) -> PathBuf {
    if has_extension(relative) {
        return relative.to_path_buf();
    }
    let mut name = relative.as_os_str().to_os_string();
    name.push(format!(".{NOTE_EXT}"));
    PathBuf::from(name)
}

/// Workspace `.gitignore` contents.
pub const GITIGNORE_FILE: &str = ".gitignore";
/// Files matched by the workspace `.gitignore`.
pub const GITIGNORE_CONTENT: &str = "# langloom workspace\n*.tmp\n";

/// Errors raised by the storage layer.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("failed to access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to serialize data for {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("no such table: {0}")]
    TableMissing(String),
    #[error("refusing to write outside the workspace: {0}")]
    UnsafePath(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("not found: {0}")]
    NotFound(PathBuf),
    #[error("invalid config for {0}: {1}")]
    Config(String, String),
}

fn io_err(path: impl Into<PathBuf>, source: io::Error) -> StorageError {
    StorageError::Io {
        path: path.into(),
        source,
    }
}

fn parse_err(path: impl Into<PathBuf>, source: serde_json::Error) -> StorageError {
    StorageError::Parse {
        path: path.into(),
        source,
    }
}

fn serialize_err(path: impl Into<PathBuf>, source: serde_json::Error) -> StorageError {
    StorageError::Serialize {
        path: path.into(),
        source,
    }
}

/// Create the standard subdirectories of a workspace.
pub fn ensure_dirs(root: &Path) -> Result<(), StorageError> {
    for dir in [
        root.to_path_buf(),
        root.join(NOTES_DIR),
        root.join(DICTIONARY_DIR),
        root.join(CONFIG_DIR),
    ] {
        fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    }
    Ok(())
}

/// Create the workspace `.gitignore` if it does not already exist.
pub fn ensure_gitignore(root: &Path) -> Result<(), StorageError> {
    let path = root.join(GITIGNORE_FILE);
    if path.exists() {
        return Ok(());
    }
    atomic_write(&path, GITIGNORE_CONTENT.as_bytes())
}

/// Default config files written when a workspace is created or opened empty.
pub const DEFAULT_CONFIG_FILES: &[&str] =
    &[LANGUAGE_FILE, GRAMMAR_FILE, TRANSLATION_FILE, SETTINGS_FILE];

/// Write any missing default config files (`config/<name>` = `{}`).
pub fn ensure_config_files(root: &Path) -> Result<(), StorageError> {
    let dir = root.join(CONFIG_DIR);
    for name in DEFAULT_CONFIG_FILES {
        let path = dir.join(name);
        if !path.exists() {
            atomic_write(&path, b"{}")?;
        }
    }
    Ok(())
}

/// Write bytes atomically by writing to a sibling temp file then renaming.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }

    let tmp = temp_path(path);
    {
        let mut file = fs::File::create(&tmp).map_err(|e| io_err(&tmp, e))?;
        file.write_all(bytes).map_err(|e| io_err(&tmp, e))?;
        file.sync_all().map_err(|e| io_err(&tmp, e))?;
    }
    fs::rename(&tmp, path).map_err(|e| io_err(path, e))
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Read a JSON value from `path`.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, StorageError> {
    let bytes = fs::read(path).map_err(|e| io_err(path, e))?;
    serde_json::from_slice(&bytes).map_err(|e| parse_err(path, e))
}

/// Write a JSON value to `path`.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
    let data = serde_json::to_vec_pretty(value).map_err(|e| serialize_err(path, e))?;
    atomic_write(path, &data)
}

/// Load a JSON value if the file exists, otherwise `None`.
pub fn load_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, StorageError> {
    if path.exists() {
        Ok(Some(read_json(path)?))
    } else {
        Ok(None)
    }
}

/// Save a JSON value, creating parent directories as needed.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StorageError> {
    write_json(path, value)
}

/// Turn a display name into a filesystem-safe slug.
pub fn slugify(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

/// Path of a table's backing file.
pub fn table_path(dictionary_dir: &Path, name: &str) -> PathBuf {
    dictionary_dir.join(slugify(name))
}

/// Join a workspace-relative path, rejecting anything that escapes the base.
pub fn safe_join(base: &Path, relative: &Path) -> Result<PathBuf, StorageError> {
    if relative.is_absolute() {
        return Err(StorageError::UnsafePath(relative.to_path_buf()));
    }

    let mut out = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(StorageError::UnsafePath(relative.to_path_buf())),
        }
    }
    Ok(out)
}

/// Write one table to `dictionary/<slug>`.
pub fn write_table(dictionary_dir: &Path, table: &WordTable) -> Result<(), StorageError> {
    write_json(&table_path(dictionary_dir, &table.name), table)
}

/// Delete a table's backing file. Missing files are not an error.
pub fn delete_table(dictionary_dir: &Path, name: &str) -> Result<(), StorageError> {
    let path = table_path(dictionary_dir, name);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(&path, e)),
    }
}

/// List regular files directly under `dir` (empty when it does not exist).
pub fn list_files(dir: &Path) -> Result<Vec<PathBuf>, StorageError> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(dir).map_err(|e| io_err(dir, e))? {
        let path = entry.map_err(|e| io_err(dir, e))?.path();
        if path.is_file() {
            files.push(path);
        }
    }
    Ok(files)
}

/// Remove a file. Missing files are not an error.
pub fn remove_file(path: &Path) -> Result<(), StorageError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(path, e)),
    }
}

/// Load every table under `dictionary/`.
pub fn scan_tables(dictionary_dir: &Path) -> Result<Vec<WordTable>, StorageError> {
    let mut tables = Vec::new();
    if !dictionary_dir.exists() {
        return Ok(tables);
    }

    for dirent in fs::read_dir(dictionary_dir).map_err(|e| io_err(dictionary_dir, e))? {
        let dirent = dirent.map_err(|e| io_err(dictionary_dir, e))?;
        let path = dirent.path();
        if path.is_file() {
            let mut table: WordTable = read_json(&path)?;
            table.ensure_wordname_tag();
            tables.push(table);
        }
    }

    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tables)
}

/// Load every note under `notes/`, recursing into subfolders.
pub fn scan_notes(notes_dir: &Path) -> Result<Vec<NoteFile>, StorageError> {
    let mut notes = Vec::new();
    if !notes_dir.exists() {
        return Ok(notes);
    }
    collect_notes(notes_dir, notes_dir, &mut notes)?;
    notes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(notes)
}

fn collect_notes(base: &Path, dir: &Path, out: &mut Vec<NoteFile>) -> Result<(), StorageError> {
    for dirent in fs::read_dir(dir).map_err(|e| io_err(dir, e))? {
        let dirent = dirent.map_err(|e| io_err(dir, e))?;
        if dirent.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = dirent.path();
        if path.is_dir() {
            collect_notes(base, &path, out)?;
        } else {
            // Non-text files (images dropped into `notes/` by hand, …) are not
            // notes; skip them instead of failing the whole workspace load.
            let raw_content = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if e.kind() == io::ErrorKind::InvalidData => continue,
                Err(e) => return Err(io_err(&path, e)),
            };
            let relative = path.strip_prefix(base).unwrap_or(&path).to_path_buf();
            out.push(NoteFile::new(relative, raw_content));
        }
    }
    Ok(())
}

/// Write a note's raw content to `notes/<relative path>`.
pub fn write_note(notes_dir: &Path, note: &NoteFile) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, &note.path)?;
    atomic_write(&path, note.raw_content.as_bytes())
}

/// Read a note's raw content from `notes/<relative path>`.
pub fn read_note(notes_dir: &Path, relative: &Path) -> Result<String, StorageError> {
    let path = safe_join(notes_dir, relative)?;
    fs::read_to_string(&path).map_err(|e| io_err(&path, e))
}

/// Create an empty note at `notes/<relative>`.
pub fn create_note(notes_dir: &Path, relative: &Path) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, relative)?;
    if path.exists() {
        return Err(StorageError::AlreadyExists(relative.to_path_buf()));
    }
    atomic_write(&path, b"")
}

/// Create a directory at `notes/<relative>`.
pub fn create_folder(notes_dir: &Path, relative: &Path) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, relative)?;
    if path.exists() {
        return Err(StorageError::AlreadyExists(relative.to_path_buf()));
    }
    fs::create_dir_all(&path).map_err(|e| io_err(&path, e))
}

/// Rename a note or folder within the notes directory. Renaming a file to a
/// bare name keeps its extension (`a.md` → `b.md`). Returns the final
/// relative path.
pub fn rename_path(notes_dir: &Path, from: &Path, to: &Path) -> Result<PathBuf, StorageError> {
    let source = safe_join(notes_dir, from)?;
    if !source.exists() {
        return Err(StorageError::NotFound(from.to_path_buf()));
    }
    let to = match source.extension() {
        Some(ext) if source.is_file() && !has_extension(to) => {
            let mut name = to.as_os_str().to_os_string();
            name.push(".");
            name.push(ext);
            PathBuf::from(name)
        }
        _ => to.to_path_buf(),
    };
    let target = safe_join(notes_dir, &to)?;
    if target.exists() {
        return Err(StorageError::AlreadyExists(to));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    fs::rename(&source, &target).map_err(|e| io_err(&source, e))?;
    Ok(to)
}

/// Rename extensionless and `.txt` notes to `.md`, returning `(from, to)`
/// pairs relative to `notes_dir`. Name collisions get a numeric suffix, and
/// files that are not valid UTF-8 text are left alone.
pub fn migrate_to_markdown(notes_dir: &Path) -> Result<Vec<(PathBuf, PathBuf)>, StorageError> {
    let mut renamed = Vec::new();
    if notes_dir.exists() {
        migrate_dir(notes_dir, notes_dir, &mut renamed)?;
    }
    Ok(renamed)
}

fn migrate_dir(
    base: &Path,
    dir: &Path,
    renamed: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), StorageError> {
    let mut entries = Vec::new();
    for dirent in fs::read_dir(dir).map_err(|e| io_err(dir, e))? {
        entries.push(dirent.map_err(|e| io_err(dir, e))?.path());
    }
    entries.sort();
    for path in entries {
        let hidden = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.'));
        if hidden {
            continue;
        }
        if path.is_dir() {
            migrate_dir(base, &path, renamed)?;
            continue;
        }
        let is_txt = path.extension().is_some_and(|ext| ext == "txt");
        if !is_txt && has_extension(&path) {
            continue;
        }
        let is_text = fs::read(&path).is_ok_and(|bytes| String::from_utf8(bytes).is_ok());
        if !is_text {
            continue;
        }
        let stem = if is_txt {
            path.with_extension("")
        } else {
            path.clone()
        };
        let mut candidate = with_note_extension(&stem);
        let mut n = 2;
        while candidate.exists() {
            let mut name = stem.as_os_str().to_os_string();
            name.push(format!(" {n}.{NOTE_EXT}"));
            candidate = PathBuf::from(name);
            n += 1;
        }
        fs::rename(&path, &candidate).map_err(|e| io_err(&path, e))?;
        let rel = |p: &Path| p.strip_prefix(base).unwrap_or(p).to_path_buf();
        renamed.push((rel(&path), rel(&candidate)));
    }
    Ok(())
}

/// Delete a note file or a folder (recursively) within the notes directory.
pub fn remove_path(notes_dir: &Path, relative: &Path) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, relative)?;
    if !path.exists() {
        return Err(StorageError::NotFound(relative.to_path_buf()));
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| io_err(&path, e))
    } else {
        fs::remove_file(&path).map_err(|e| io_err(&path, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field::FieldValue;
    use crate::model::{TagDef, WordEntry};

    #[test]
    fn table_round_trips_extensionless() {
        let dir = tempfile::tempdir().unwrap();
        let dict = dir.path().join(DICTIONARY_DIR);
        fs::create_dir_all(&dict).unwrap();

        let mut table = WordTable::new("all words");
        table.add_tag(TagDef::new(
            "part of speech",
            crate::model::FieldType::TagList,
        ));
        let mut entry = WordEntry::new("kala");
        entry.set("part of speech", FieldValue::TagList(vec!["noun".into()]));
        table.add_entry(entry);

        write_table(&dict, &table).unwrap();
        let written = dict.join("all_words");
        assert!(written.is_file());
        assert_eq!(written.extension(), None);

        let loaded = scan_tables(&dict).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "all words");
        assert!(loaded[0].has_tag("part of speech"));
    }

    #[test]
    fn sparse_word_reloads_without_empty_tags() {
        let dir = tempfile::tempdir().unwrap();
        let dict = dir.path().join(DICTIONARY_DIR);
        fs::create_dir_all(&dict).unwrap();

        let mut table = WordTable::new("verbs");
        table.add_tag(TagDef::new("formality", crate::model::FieldType::Text));
        table.add_entry(WordEntry::new("velo"));
        write_table(&dict, &table).unwrap();

        let loaded = scan_tables(&dict).unwrap();
        let entry = &loaded[0].entries[0];
        assert!(!entry.has("formality"));
        assert!(entry.values.is_empty());
    }

    #[test]
    fn config_json_loads_or_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_DIR).join(SETTINGS_FILE);

        let missing: Option<crate::config::WorkspaceSettings> = load_json(&path).unwrap();
        assert!(missing.is_none());

        save_json(&path, &crate::config::WorkspaceSettings::default()).unwrap();
        assert!(path.extension().is_none());
        let loaded: crate::config::WorkspaceSettings = load_json(&path).unwrap().unwrap();
        assert!(loaded.auto_checkin);
    }

    #[test]
    fn note_extension_rules() {
        assert_eq!(with_note_extension(Path::new("idea")), Path::new("idea.md"));
        assert_eq!(with_note_extension(Path::new("a/b")), Path::new("a/b.md"));
        assert_eq!(with_note_extension(Path::new("x.txt")), Path::new("x.txt"));
        // The tail of a title is not an extension.
        assert_eq!(
            with_note_extension(Path::new("v1.2 notes")),
            Path::new("v1.2 notes.md")
        );
    }

    #[test]
    fn migration_renames_once_and_avoids_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(notes.join("sub")).unwrap();
        fs::write(notes.join("plain"), "a").unwrap();
        fs::write(notes.join("old.txt"), "b").unwrap();
        fs::write(notes.join("keep.md"), "c").unwrap();
        fs::write(notes.join("sub/deep"), "d").unwrap();
        // Collision: `clash` and an existing `clash.md`.
        fs::write(notes.join("clash"), "e").unwrap();
        fs::write(notes.join("clash.md"), "f").unwrap();
        // Binary data and hidden files are untouched.
        fs::write(notes.join("blob"), [0xff, 0xfe, 0x00]).unwrap();
        fs::write(notes.join(".hidden"), "h").unwrap();

        let renamed = migrate_to_markdown(&notes).unwrap();
        assert_eq!(renamed.len(), 4);
        assert!(notes.join("plain.md").exists());
        assert!(notes.join("old.md").exists());
        assert!(!notes.join("old.txt").exists());
        assert!(notes.join("sub/deep.md").exists());
        assert!(notes.join("clash 2.md").exists());
        assert_eq!(fs::read_to_string(notes.join("clash.md")).unwrap(), "f");
        assert!(notes.join("blob").exists());
        assert!(notes.join(".hidden").exists());

        assert!(migrate_to_markdown(&notes).unwrap().is_empty());
    }

    #[test]
    fn rename_keeps_file_extension_and_scan_skips_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(&notes).unwrap();
        write_note(&notes, &NoteFile::new("a.md", "x")).unwrap();
        fs::write(notes.join("pic.bin"), [0xff, 0xfe, 0xfd]).unwrap();

        rename_path(&notes, Path::new("a.md"), Path::new("b")).unwrap();
        assert!(notes.join("b.md").exists());

        let loaded = scan_notes(&notes).unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn notes_scan_nested_folders() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(notes.join("Grammar")).unwrap();

        write_note(&notes, &NoteFile::new("Grammar/phonology", "### Vowels")).unwrap();
        write_note(&notes, &NoteFile::new("overview", "# Lang")).unwrap();

        let loaded = scan_notes(&notes).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].path, PathBuf::from("Grammar/phonology"));
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let base = Path::new("/tmp/ws/notes");
        assert!(safe_join(base, Path::new("../secret")).is_err());
        assert!(safe_join(base, Path::new("/etc/passwd")).is_err());
        assert_eq!(
            safe_join(base, Path::new("Grammar/phonology")).unwrap(),
            PathBuf::from("/tmp/ws/notes/Grammar/phonology")
        );
    }

    #[test]
    fn slugs_are_clean() {
        assert_eq!(slugify("all words"), "all_words");
        assert_eq!(slugify("???"), "untitled");
    }

    #[test]
    fn gitignore_is_created_once() {
        let dir = tempfile::tempdir().unwrap();
        ensure_gitignore(dir.path()).unwrap();
        let path = dir.path().join(GITIGNORE_FILE);
        assert_eq!(fs::read_to_string(&path).unwrap(), GITIGNORE_CONTENT);
    }

    #[test]
    fn note_and_folder_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(&notes).unwrap();

        create_folder(&notes, Path::new("Grammar")).unwrap();
        assert!(notes.join("Grammar").is_dir());
        assert!(matches!(
            create_folder(&notes, Path::new("Grammar")),
            Err(StorageError::AlreadyExists(_))
        ));

        create_note(&notes, Path::new("Grammar/phonology")).unwrap();
        assert!(notes.join("Grammar/phonology").exists());
        assert!(matches!(
            create_note(&notes, Path::new("Grammar/phonology")),
            Err(StorageError::AlreadyExists(_))
        ));

        rename_path(
            &notes,
            Path::new("Grammar/phonology"),
            Path::new("Grammar/sounds"),
        )
        .unwrap();
        assert!(!notes.join("Grammar/phonology").exists());
        assert!(notes.join("Grammar/sounds").exists());

        remove_path(&notes, Path::new("Grammar")).unwrap();
        assert!(!notes.join("Grammar").exists());
        assert!(matches!(
            remove_path(&notes, Path::new("Grammar")),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn scaffold_writes_default_config_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ensure_dirs(root).unwrap();
        ensure_config_files(root).unwrap();
        for name in DEFAULT_CONFIG_FILES {
            assert!(root.join(CONFIG_DIR).join(name).is_file());
        }
    }

    #[test]
    fn hidden_files_and_dirs_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(notes.join(".hiddendir")).unwrap();

        write_note(&notes, &NoteFile::new("visible", "ok")).unwrap();
        write_note(&notes, &NoteFile::new(".hidden", "no")).unwrap();
        write_note(&notes, &NoteFile::new(".hiddendir/inner", "no")).unwrap();

        let loaded = scan_notes(&notes).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, PathBuf::from("visible"));
    }

    #[test]
    fn read_note_guards_and_reads() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(&notes).unwrap();
        write_note(&notes, &NoteFile::new("Grammar/phonology", "### Vowels")).unwrap();

        assert_eq!(
            read_note(&notes, Path::new("Grammar/phonology")).unwrap(),
            "### Vowels"
        );
        assert!(matches!(
            read_note(&notes, Path::new("../secret")),
            Err(StorageError::UnsafePath(_))
        ));
    }
}
