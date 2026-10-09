//! Plain-file persistence for a workspace (extensionless tables/config, `.md`
//! notes).
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

use super::assets::{ASSETS_DIR, MAX_ASSET_BYTES};

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
/// `config/` file holding the phoneme inventory and syllable shapes.
pub const PHONOLOGY_FILE: &str = "phonology";
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
pub const GITIGNORE_CONTENT: &str = "# nueon workspace\n*.tmp\n.trash/\n";

/// Lines every workspace `.gitignore` must contain. The trash must never be
/// committed by auto-check-in (it would fill history with moves in and out).
const REQUIRED_IGNORES: &[&str] = &["*.tmp", ".trash/"];

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
    #[error("not a regular file: {0}")]
    NotAFile(PathBuf),
    #[error("file is too large to import: {0}")]
    TooLarge(PathBuf),
    #[error("conflict: {0} changed on disk since it was opened")]
    Conflict(PathBuf),
    #[error("already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("not found: {0}")]
    NotFound(PathBuf),
    #[error("invalid config for {0}: {1}")]
    Config(String, String),
}

pub(super) fn io_err(path: impl Into<PathBuf>, source: io::Error) -> StorageError {
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

/// Create the workspace `.gitignore`, or append any required line it lacks.
///
/// An existing file is never rewritten: user lines, comments and order stay
/// exactly as they were, and missing entries are only appended.
pub fn ensure_gitignore(root: &Path) -> Result<(), StorageError> {
    let path = root.join(GITIGNORE_FILE);
    if !path.exists() {
        return atomic_write(&path, GITIGNORE_CONTENT.as_bytes());
    }
    let existing = fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
    let has = |wanted: &str| {
        existing.lines().any(|line| {
            let line = line.trim();
            line == wanted || line == format!("/{wanted}") || line == wanted.trim_end_matches('/')
        })
    };
    let missing: Vec<&str> = REQUIRED_IGNORES
        .iter()
        .copied()
        .filter(|l| !has(l))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    for line in missing {
        updated.push_str(line);
        updated.push('\n');
    }
    atomic_write(&path, updated.as_bytes())
}

/// Default config files written when a workspace is created or opened empty.
pub const DEFAULT_CONFIG_FILES: &[&str] = &[
    LANGUAGE_FILE,
    GRAMMAR_FILE,
    TRANSLATION_FILE,
    PHONOLOGY_FILE,
    SETTINGS_FILE,
];

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

/// A unique, hidden temp file beside `path`.
///
/// Unique so two writers (or two windows) never share a temp file, and hidden
/// so a leftover from a crash is not mistaken for a note or table.
pub(super) fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let unique = uuid::Uuid::new_v4().simple().to_string();
    path.with_file_name(format!(".{name}.{}.tmp", &unique[..12]))
}

/// Move `from` to `to` **without ever replacing** an existing target, even if
/// another writer creates `to` at the same moment.
///
/// - Files: `hard_link(from, to)` is a single atomic filesystem operation that
///   fails with `AlreadyExists` if `to` exists, followed by removing `from`.
///   If the filesystem has no hard links, `to` is first claimed with an
///   exclusive `create_new`, then `from` is renamed over our own placeholder.
/// - Directories: `rename(2)` cannot replace a non-empty directory (it fails
///   with `ENOTEMPTY`) or a file, so the only target it could ever take over
///   is an empty directory created in the same instant, which holds no data.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        if fs::symlink_metadata(to).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "target exists",
            ));
        }
        return fs::rename(from, to);
    }
    match fs::hard_link(from, to) {
        Ok(()) => {
            if let Err(err) = fs::remove_file(from) {
                // Could not finish the move: undo our link so nothing is duplicated.
                let _ = fs::remove_file(to);
                return Err(err);
            }
            Ok(())
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(err),
        Err(_) => {
            // No hard links here: claim the name exclusively, then take it over.
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(to)?;
            if let Err(err) = fs::rename(from, to) {
                let _ = fs::remove_file(to);
                return Err(err);
            }
            Ok(())
        }
    }
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
///
/// Only used by tests now: production code resolves a table's filename once,
/// through [`super::table_files`], and never recomputes it from the name.
#[cfg(test)]
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

/// Path of a table's backing file. Test-only (see [`slugify`]).
#[cfg(test)]
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

/// Write one table to `dictionary/<slug>` (a fresh slug — only correct for
/// code paths that do not yet have a resolved filename, namely tests).
#[cfg(test)]
pub fn write_table(dictionary_dir: &Path, table: &WordTable) -> Result<(), StorageError> {
    write_json(&table_path(dictionary_dir, &table.name), table)
}

/// Delete one specific, already-resolved file. Missing files are not an
/// error. Unlike the old blanket "delete anything not in the snapshot"
/// behaviour this removed, the caller must name the exact file: nothing here
/// ever infers what to delete from a directory listing.
pub fn remove_silently(path: &Path) -> Result<(), StorageError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(path, e)),
    }
}

/// Write one table to its already-resolved filename. Everything in
/// [`Workspace`](crate::Workspace) goes through this: filenames are resolved
/// once (see [`super::table_files`]) and never recomputed from the name.
pub fn write_table_file(path: &Path, table: &WordTable) -> Result<(), StorageError> {
    write_json(path, table)
}

/// Load every table under `dictionary/`, failing on the first unreadable
/// file. Test-only: production code uses the tolerant
/// [`super::table_files::scan_tables_tolerant`], which never lets one bad
/// file stop the rest of the workspace from loading.
#[cfg(test)]
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
        // `notes/assets/` holds imported files, never notes.
        if dir == base && dirent.file_name() == ASSETS_DIR {
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

/// Create or overwrite a note (test fixtures only: the app never creates a
/// note by saving, see [`write_existing_note`]).
#[cfg(test)]
pub fn write_note(notes_dir: &Path, note: &NoteFile) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, &note.path)?;
    atomic_write(&path, note.raw_content.as_bytes())
}

/// A short content hash used to detect on-disk changes between load and save.
pub fn content_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Overwrite an **existing** note.
///
/// Saving never creates a file: an editor holding a stale buffer for a note
/// that was deleted or renamed must fail instead of resurrecting it. When
/// `base_hash` is given, the write is refused with `Conflict` if the file no
/// longer matches the content the caller loaded, unless it already equals
/// the new content (then it succeeds without writing). Returns the new hash
/// and whether the file was written.
pub fn write_existing_note(
    notes_dir: &Path,
    relative: &Path,
    content: &str,
    base_hash: Option<&str>,
) -> Result<(String, bool), StorageError> {
    let path = safe_join(notes_dir, relative)?;
    if !path.is_file() {
        return Err(StorageError::NotFound(relative.to_path_buf()));
    }
    let current = fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
    // The file already holds exactly what is being saved: nothing to write
    // and nothing to conflict with, whatever base the caller started from.
    if current == content {
        return Ok((content_hash(content), false));
    }
    if let Some(base) = base_hash {
        if content_hash(&current) != base {
            return Err(StorageError::Conflict(relative.to_path_buf()));
        }
    }
    atomic_write(&path, content.as_bytes())?;
    Ok((content_hash(content), true))
}

/// Read a note and its content hash.
pub fn read_note_snapshot(
    notes_dir: &Path,
    relative: &Path,
) -> Result<(String, String), StorageError> {
    let text = read_note(notes_dir, relative)?;
    let hash = content_hash(&text);
    Ok((text, hash))
}

/// Read a note's raw content from `notes/<relative path>`.
pub fn read_note(notes_dir: &Path, relative: &Path) -> Result<String, StorageError> {
    let path = safe_join(notes_dir, relative)?;
    fs::read_to_string(&path).map_err(|e| io_err(&path, e))
}

/// Create an empty note at `notes/<relative>`.
pub fn create_note(notes_dir: &Path, relative: &Path) -> Result<(), StorageError> {
    let path = safe_join(notes_dir, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    // `create_new` is atomic: it fails if the note exists, even under a race.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            Err(StorageError::AlreadyExists(relative.to_path_buf()))
        }
        Err(err) => Err(io_err(&path, err)),
    }
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
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    // Never replaces an existing target, even under a race.
    match rename_noreplace(&source, &target) {
        Ok(()) => Ok(to),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            Err(StorageError::AlreadyExists(to))
        }
        Err(err) => Err(io_err(&source, err)),
    }
}

/// Split `name` into `(stem, extension)` — the extension only when its tail
/// looks like one, so `archive.tar.gz` → `("archive.tar", ".gz")` but
/// `.gitignore` stays whole.
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 && looks_like_extension(&name[index + 1..]) => {
            (&name[..index], &name[index..])
        }
        _ => (name, ""),
    }
}

/// Copy a regular file into `notes/<folder>` under its **own name**, suffixing
/// ` 2`, ` 3`, … when that name is taken. Nothing is overwritten; the source is
/// left untouched. Returns the new path relative to `notes_dir`.
pub fn copy_into(notes_dir: &Path, folder: &Path, source: &Path) -> Result<PathBuf, StorageError> {
    // `metadata` follows symlinks, so a link to a directory is rejected too.
    let meta = fs::metadata(source).map_err(|e| io_err(source, e))?;
    if !meta.is_file() {
        return Err(StorageError::NotAFile(source.to_path_buf()));
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(StorageError::TooLarge(source.to_path_buf()));
    }

    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let dir = safe_join(notes_dir, folder)?;
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;

    // Copy once to a unique temp file beside the target, then move it into
    // place without replacing anything.
    let temp = temp_path(&dir.join("copy"));
    fs::copy(source, &temp).map_err(|e| io_err(source, e))?;

    let (stem, extension) = split_name(&name);
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            name.clone()
        } else {
            format!("{stem} {n}{extension}")
        };
        let target = dir.join(&candidate);
        if target.exists() {
            if n < 10_000 {
                n += 1;
                continue;
            }
            let _ = fs::remove_file(&temp);
            return Err(StorageError::AlreadyExists(folder.join(&candidate)));
        }
        match rename_noreplace(&temp, &target) {
            Ok(()) => return Ok(folder.join(&candidate)),
            // Lost a race to claim this name; try the next suffix.
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                continue;
            }
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(io_err(&target, err));
            }
        }
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
    fn existing_note_writes_detect_conflicts_and_skip_no_ops() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(&notes).unwrap();
        write_note(&notes, &NoteFile::new("a.md", "one")).unwrap();
        let (text, hash) = read_note_snapshot(&notes, Path::new("a.md")).unwrap();
        assert_eq!(text, "one");

        // Saving identical content writes nothing.
        let (same, wrote) =
            write_existing_note(&notes, Path::new("a.md"), "one", Some(&hash)).unwrap();
        assert_eq!((same, wrote), (hash.clone(), false));

        // A normal save returns the new hash, which becomes the next base.
        let (next, wrote) =
            write_existing_note(&notes, Path::new("a.md"), "two", Some(&hash)).unwrap();
        assert!(wrote);
        assert_ne!(next, hash);

        // Someone else changes the file; the stale base is refused.
        fs::write(notes.join("a.md"), "external").unwrap();
        assert!(matches!(
            write_existing_note(&notes, Path::new("a.md"), "mine", Some(&next)),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(fs::read_to_string(notes.join("a.md")).unwrap(), "external");

        // Missing notes and escapes are rejected.
        assert!(matches!(
            write_existing_note(&notes, Path::new("nope.md"), "x", None),
            Err(StorageError::NotFound(_))
        ));
        assert!(write_existing_note(&notes, Path::new("../x"), "x", None).is_err());
        assert!(!notes.join("nope.md").exists());
    }

    #[test]
    fn saving_content_already_on_disk_is_not_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(&notes).unwrap();
        write_note(&notes, &NoteFile::new("a.md", "one")).unwrap();
        let stale = content_hash("something older");

        // The file already holds what is being saved (another window got
        // there first): succeed, write nothing, and report the real hash.
        let (hash, wrote) =
            write_existing_note(&notes, Path::new("a.md"), "one", Some(&stale)).unwrap();
        assert_eq!((hash, wrote), (content_hash("one"), false));

        // Different content with a stale base is still a conflict.
        assert!(matches!(
            write_existing_note(&notes, Path::new("a.md"), "two", Some(&stale)),
            Err(StorageError::Conflict(_))
        ));
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
    fn scan_notes_skips_the_assets_folder() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIR);
        fs::create_dir_all(notes.join(ASSETS_DIR)).unwrap();
        write_note(&notes, &NoteFile::new("real.md", "note")).unwrap();
        // A text asset under assets/ is not a note.
        fs::write(notes.join(ASSETS_DIR).join("readme.txt"), "asset text").unwrap();

        let loaded = scan_notes(&notes).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, PathBuf::from("real.md"));
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
        assert!(GITIGNORE_CONTENT.contains(".trash/"));
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

        // Missing sources are reported, not silently ignored.
        assert!(matches!(
            rename_path(&notes, Path::new("Nope"), Path::new("Other")),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn rename_never_replaces_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a"), "A").unwrap();
        fs::write(root.join("b"), "B").unwrap();
        let err = rename_noreplace(&root.join("a"), &root.join("b")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "A");
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "B");

        // Directories too: a non-empty target is never taken over.
        fs::create_dir_all(root.join("d1")).unwrap();
        fs::create_dir_all(root.join("d2")).unwrap();
        fs::write(root.join("d2/keep"), "x").unwrap();
        assert!(rename_noreplace(&root.join("d1"), &root.join("d2")).is_err());
        assert!(root.join("d1").is_dir());
        assert!(root.join("d2/keep").exists());

        // A free target works and removes the source.
        rename_noreplace(&root.join("a"), &root.join("c")).unwrap();
        assert!(!root.join("a").exists());
        assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "A");
    }

    #[test]
    fn concurrent_renames_to_one_target_have_exactly_one_winner() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let root = Arc::new(dir.path().to_path_buf());
        let n = 16;
        for i in 0..n {
            fs::write(root.join(format!("src{i}")), format!("content {i}")).unwrap();
        }
        let barrier = Arc::new(Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let (root, barrier) = (Arc::clone(&root), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    rename_noreplace(&root.join(format!("src{i}")), &root.join("target"))
                        .map(|()| i)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let winners: Vec<usize> = results
            .iter()
            .filter_map(|r| r.as_ref().ok().copied())
            .collect();
        assert_eq!(winners.len(), 1, "exactly one rename may win");
        let won = winners[0];
        assert_eq!(
            fs::read_to_string(root.join("target")).unwrap(),
            format!("content {won}")
        );
        // Every loser still has its source file, untouched.
        for i in (0..n).filter(|i| *i != won) {
            assert_eq!(
                fs::read_to_string(root.join(format!("src{i}"))).unwrap(),
                format!("content {i}")
            );
        }
    }

    #[test]
    fn concurrent_note_creation_has_one_creator() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let notes = Arc::new(dir.path().join(NOTES_DIR));
        fs::create_dir_all(&*notes).unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (notes, barrier) = (Arc::clone(&notes), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    create_note(&notes, Path::new("same.md")).is_ok()
                })
            })
            .collect();
        let created = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(created, 1);
    }

    #[test]
    fn temp_files_are_unique_and_hidden() {
        let a = temp_path(Path::new("/x/notes/a.md"));
        let b = temp_path(Path::new("/x/notes/a.md"));
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.') && name.ends_with(".tmp"));
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
