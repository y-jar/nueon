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
        let path = dirent.path();
        if path.is_dir() {
            collect_notes(base, &path, out)?;
        } else {
            let raw_content = fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
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
}
