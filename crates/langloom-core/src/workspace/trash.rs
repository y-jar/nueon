//! Recoverable deletion.
//!
//! Deleted notes, folders and tables are moved into `<workspace>/.trash/`
//! instead of being removed. Each deletion gets its own directory
//! `.trash/<unix-seconds>-<uuid>/` holding a `manifest.json` (what it was and
//! where it came from) and the item itself under the fixed name `item`.
//!
//! Safety rules, all enforced here:
//! - the move is a same-filesystem `rename` (atomic, never a copy-then-delete);
//! - the manifest is written **before** the item moves, so an item is never
//!   orphaned without a record of where it belongs;
//! - restoring resolves the manifest's path through [`safe_join`], so a crafted
//!   manifest can never write outside the workspace, and it never overwrites:
//!   a clash restores under a unique name;
//! - pruning and emptying only ever touch directories whose names match the
//!   entry pattern exactly, and never follow symlinks.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::storage::{io_err, read_json, rename_noreplace, safe_join, write_json, StorageError};
use crate::model::WordTable;

/// Directory (at the workspace root) holding deleted items.
pub const TRASH_DIR: &str = ".trash";
/// The manifest file inside each entry.
pub const MANIFEST_FILE: &str = "manifest.json";
/// The deleted item inside each entry.
pub const ITEM_NAME: &str = "item";
/// Entries older than this are pruned when a workspace opens.
pub const RETENTION_DAYS: u64 = 30;

const MANIFEST_VERSION: u32 = 1;
/// Manifests are tiny; refuse to read anything unreasonable.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// What was deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashKind {
    Note,
    Folder,
    Table,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    kind: TrashKind,
    /// Notes/folders: path relative to `notes/`. Tables: the table name.
    original: String,
    deleted_at: u64,
    #[serde(default)]
    count: usize,
}

/// A trashed item as shown to the user.
#[derive(Debug, Clone, Serialize)]
pub struct TrashRecord {
    /// Entry directory name; the handle for restore/purge.
    pub id: String,
    pub kind: TrashKind,
    pub original: String,
    /// Display name (last path segment, or the table name).
    pub name: String,
    pub deleted_at: u64,
    /// Number of notes inside (1 for a single note or table).
    pub count: usize,
}

/// What a restore produced.
#[derive(Debug, Clone, Serialize)]
pub struct Restored {
    pub kind: TrashKind,
    /// Notes/folders: the restored path relative to `notes/`. Tables: the name.
    pub name: String,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether `name` is exactly `<9-13 digit seconds>-<32 lowercase hex>`.
pub fn is_entry_name(name: &str) -> bool {
    let Some((seconds, uuid)) = name.split_once('-') else {
        return false;
    };
    (9..=13).contains(&seconds.len())
        && seconds.bytes().all(|b| b.is_ascii_digit())
        && uuid.len() == 32
        && uuid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn entry_seconds(name: &str) -> u64 {
    name.split_once('-')
        .and_then(|(seconds, _)| seconds.parse().ok())
        .unwrap_or(0)
}

fn trash_root(root: &Path) -> PathBuf {
    root.join(TRASH_DIR)
}

/// The entry directory for `id`, only if `id` is a well-formed entry name that
/// is a real directory (a symlink is never followed).
fn entry_dir(root: &Path, id: &str) -> Result<PathBuf, StorageError> {
    if !is_entry_name(id) {
        return Err(StorageError::UnsafePath(PathBuf::from(id)));
    }
    let dir = trash_root(root).join(id);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => Ok(dir),
        Ok(_) => Err(StorageError::UnsafePath(dir)),
        Err(_) => Err(StorageError::NotFound(dir)),
    }
}

fn read_manifest(dir: &Path) -> Result<Manifest, StorageError> {
    let path = dir.join(MANIFEST_FILE);
    let meta = fs::metadata(&path).map_err(|e| io_err(&path, e))?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(StorageError::TooLarge(path));
    }
    read_json(&path)
}

fn display_name(kind: TrashKind, original: &str) -> String {
    match kind {
        TrashKind::Table => original.to_string(),
        _ => original.rsplit('/').next().unwrap_or(original).to_string(),
    }
}

fn record_from(id: &str, manifest: &Manifest) -> TrashRecord {
    TrashRecord {
        id: id.to_string(),
        kind: manifest.kind,
        original: manifest.original.clone(),
        name: display_name(manifest.kind, &manifest.original),
        deleted_at: manifest.deleted_at,
        count: manifest.count.max(1),
    }
}

/// Number of regular files under `path` (1 for a file).
pub fn count_files(path: &Path) -> usize {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::read_dir(path)
            .map(|read| {
                read.filter_map(Result::ok)
                    .map(|e| count_files(&e.path()))
                    .sum()
            })
            .unwrap_or(0),
        Ok(_) => 1,
        Err(_) => 0,
    }
}

/// Create a fresh entry directory with its manifest. The caller then places
/// the item at `<dir>/item`.
fn new_entry(root: &Path, manifest: &Manifest) -> Result<(String, PathBuf), StorageError> {
    let trash = trash_root(root);
    fs::create_dir_all(&trash).map_err(|e| io_err(&trash, e))?;
    let id = format!("{}-{}", manifest.deleted_at, Uuid::new_v4().simple());
    let dir = trash.join(&id);
    fs::create_dir(&dir).map_err(|e| io_err(&dir, e))?;
    if let Err(err) = write_json(&dir.join(MANIFEST_FILE), manifest) {
        let _ = fs::remove_dir_all(&dir);
        return Err(err);
    }
    Ok((id, dir))
}

/// Move a note file or folder into the trash.
pub fn trash_path(
    root: &Path,
    source: &Path,
    kind: TrashKind,
    original: String,
    count: usize,
) -> Result<TrashRecord, StorageError> {
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        kind,
        original,
        deleted_at: now_secs(),
        count,
    };
    let (id, dir) = new_entry(root, &manifest)?;
    // Same filesystem as the workspace, so this is one atomic rename. If it
    // cannot be (a mount boundary), fail rather than copy and delete.
    if let Err(err) = fs::rename(source, dir.join(ITEM_NAME)) {
        let _ = fs::remove_dir_all(&dir);
        return Err(io_err(source, err));
    }
    Ok(record_from(&id, &manifest))
}

/// Move a table's file into the trash (or, if it never reached disk, save its
/// in-memory content there).
pub fn trash_table(
    root: &Path,
    table: &WordTable,
    file: &Path,
) -> Result<TrashRecord, StorageError> {
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        kind: TrashKind::Table,
        original: table.name.clone(),
        deleted_at: now_secs(),
        count: 1,
    };
    let (id, dir) = new_entry(root, &manifest)?;
    let item = dir.join(ITEM_NAME);
    let moved = if file.is_file() {
        fs::rename(file, &item).map_err(|e| io_err(file, e))
    } else {
        write_json(&item, table)
    };
    if let Err(err) = moved {
        let _ = fs::remove_dir_all(&dir);
        return Err(err);
    }
    Ok(record_from(&id, &manifest))
}

/// Every well-formed entry, newest first. Anything else under `.trash/` is
/// ignored (and never touched).
pub fn list(root: &Path) -> Vec<TrashRecord> {
    let Ok(read) = fs::read_dir(trash_root(root)) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for dirent in read.filter_map(Result::ok) {
        let name = dirent.file_name().to_string_lossy().into_owned();
        if !is_entry_name(&name) {
            continue;
        }
        if let Ok(dir) = entry_dir(root, &name) {
            if let Ok(manifest) = read_manifest(&dir) {
                records.push(record_from(&name, &manifest));
            }
        }
    }
    records.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    records
}

/// `name`, or `name (restored)`, `name (restored 2)`, … keeping the extension.
fn restored_candidate(original: &Path, attempt: u32) -> PathBuf {
    if attempt == 0 {
        return original.to_path_buf();
    }
    let suffix = if attempt == 1 {
        " (restored)".to_string()
    } else {
        format!(" (restored {attempt})")
    };
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = match original.extension() {
        Some(ext) => format!("{stem}{suffix}.{}", ext.to_string_lossy()),
        None => format!("{stem}{suffix}"),
    };
    original.with_file_name(name)
}

/// Restore a trashed note or folder into `notes_dir`; returns the path it was
/// restored to, relative to `notes_dir`.
pub fn restore_notes(root: &Path, notes_dir: &Path, id: &str) -> Result<PathBuf, StorageError> {
    let dir = entry_dir(root, id)?;
    let manifest = read_manifest(&dir)?;
    if !matches!(manifest.kind, TrashKind::Note | TrashKind::Folder) {
        return Err(StorageError::Config(
            id.to_string(),
            "not a note or folder".to_string(),
        ));
    }
    let original = Path::new(&manifest.original);
    // The manifest is untrusted input: an empty, absolute or `..` path is
    // rejected by the same guard every other workspace path goes through.
    if manifest.original.trim().is_empty() {
        return Err(StorageError::UnsafePath(original.to_path_buf()));
    }
    safe_join(notes_dir, original)?;

    let item = dir.join(ITEM_NAME);
    if fs::symlink_metadata(&item).is_err() {
        return Err(StorageError::NotFound(item));
    }
    for attempt in 0..1000 {
        let relative = restored_candidate(original, attempt);
        let target = safe_join(notes_dir, &relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
        }
        match rename_noreplace(&item, &target) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&dir);
                return Ok(relative);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(io_err(&item, err)),
        }
    }
    Err(StorageError::AlreadyExists(original.to_path_buf()))
}

/// Read a trashed table (without removing the entry).
pub fn read_table(root: &Path, id: &str) -> Result<WordTable, StorageError> {
    let dir = entry_dir(root, id)?;
    let manifest = read_manifest(&dir)?;
    if manifest.kind != TrashKind::Table {
        return Err(StorageError::Config(
            id.to_string(),
            "not a table".to_string(),
        ));
    }
    read_json(&dir.join(ITEM_NAME))
}

/// Delete one entry for good.
pub fn purge(root: &Path, id: &str) -> Result<(), StorageError> {
    let dir = entry_dir(root, id)?;
    fs::remove_dir_all(&dir).map_err(|e| io_err(&dir, e))
}

/// Delete every entry; returns how many were removed.
pub fn empty(root: &Path) -> usize {
    let mut removed = 0;
    if let Ok(read) = fs::read_dir(trash_root(root)) {
        for dirent in read.filter_map(Result::ok) {
            let name = dirent.file_name().to_string_lossy().into_owned();
            if is_entry_name(&name) && purge(root, &name).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Remove entries older than `max_age_days` as of `now`. Only directories whose
/// names match the entry pattern are considered, judged by the timestamp in the
/// *name* (a manifest cannot extend its own life).
pub fn prune(root: &Path, now: u64, max_age_days: u64) -> usize {
    let cutoff = now.saturating_sub(max_age_days.saturating_mul(86_400));
    let mut removed = 0;
    if let Ok(read) = fs::read_dir(trash_root(root)) {
        for dirent in read.filter_map(Result::ok) {
            let name = dirent.file_name().to_string_lossy().into_owned();
            if is_entry_name(&name) && entry_seconds(&name) < cutoff && purge(root, &name).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Drop trash entries holding exactly this table: it was just brought back
/// (by undo, redo or restore), so the copy would only be a duplicate.
pub fn consume_table(root: &Path, table: &WordTable) {
    for record in list(root) {
        if record.kind == TrashKind::Table
            && record.original == table.name
            && read_table(root, &record.id).is_ok_and(|trashed| &trashed == table)
        {
            let _ = purge(root, &record.id);
        }
    }
}

/// Write a note's file name safely into the trash listing helpers' tests.
#[cfg(test)]
pub(super) fn write_entry_for_test(
    root: &Path,
    id: &str,
    kind: &str,
    original: &str,
    item: &[u8],
) -> PathBuf {
    use crate::workspace::storage::atomic_write;
    let dir = trash_root(root).join(id);
    fs::create_dir_all(&dir).unwrap();
    let manifest = format!(
        r#"{{"version":1,"kind":"{kind}","original":{},"deleted_at":{},"count":1}}"#,
        serde_json::to_string(original).unwrap(),
        entry_seconds(id)
    );
    atomic_write(&dir.join(MANIFEST_FILE), manifest.as_bytes()).unwrap();
    fs::write(dir.join(ITEM_NAME), item).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "1700000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "1700000500-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn workspace() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let notes = root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        (dir, root, notes)
    }

    #[test]
    fn entry_names_are_strict() {
        assert!(is_entry_name(ID_A));
        for bad in [
            "",
            "not-an-entry",
            "1700000000-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "1700000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1700000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "170000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "../1700000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "1700000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/..",
        ] {
            assert!(!is_entry_name(bad), "{bad:?} must not match");
        }
    }

    #[test]
    fn trash_then_restore_round_trips_a_note_and_a_folder() {
        let (_dir, root, notes) = workspace();
        fs::create_dir_all(notes.join("lore")).unwrap();
        fs::write(notes.join("lore/a.md"), "A").unwrap();
        fs::write(notes.join("lore/b.md"), "B").unwrap();

        let folder = trash_path(
            &root,
            &notes.join("lore"),
            TrashKind::Folder,
            "lore".into(),
            count_files(&notes.join("lore")),
        )
        .unwrap();
        assert_eq!(folder.count, 2);
        assert!(!notes.join("lore").exists());
        assert_eq!(list(&root).len(), 1);

        let restored = restore_notes(&root, &notes, &folder.id).unwrap();
        assert_eq!(restored, Path::new("lore"));
        assert_eq!(fs::read_to_string(notes.join("lore/b.md")).unwrap(), "B");
        assert!(list(&root).is_empty(), "the entry is gone after restore");
    }

    #[test]
    fn restore_never_overwrites_and_picks_a_unique_name() {
        let (_dir, root, notes) = workspace();
        fs::write(notes.join("n.md"), "old").unwrap();
        let first = trash_path(
            &root,
            &notes.join("n.md"),
            TrashKind::Note,
            "n.md".into(),
            1,
        )
        .unwrap();

        // Something new now lives at the original path (and the first
        // candidate for the unique name).
        fs::write(notes.join("n.md"), "new").unwrap();
        fs::write(notes.join("n (restored).md"), "also new").unwrap();

        let restored = restore_notes(&root, &notes, &first.id).unwrap();
        assert_eq!(restored, Path::new("n (restored 2).md"));
        assert_eq!(fs::read_to_string(notes.join("n.md")).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(notes.join("n (restored).md")).unwrap(),
            "also new"
        );
        assert_eq!(
            fs::read_to_string(notes.join("n (restored 2).md")).unwrap(),
            "old"
        );
    }

    #[test]
    fn a_crafted_manifest_cannot_restore_outside_the_workspace() {
        let (dir, root, notes) = workspace();
        let outside = dir.path().join("outside.md");

        for evil in [
            "../outside.md",
            "../../outside.md",
            "lore/../../outside.md",
            outside.to_str().unwrap(),
            "/etc/passwd-restored",
            "",
            "   ",
        ] {
            let entry = write_entry_for_test(&root, ID_A, "note", evil, b"payload");
            let result = restore_notes(&root, &notes, ID_A);
            assert!(result.is_err(), "manifest path {evil:?} must be refused");
            assert!(!outside.exists(), "nothing may land outside the workspace");
            // The entry and its payload are left alone for the user.
            assert!(entry.join(ITEM_NAME).exists());
            fs::remove_dir_all(&entry).unwrap();
        }
        assert!(!Path::new("/etc/passwd-restored").exists());
    }

    #[test]
    fn restore_and_purge_reject_ids_that_are_not_plain_entry_names() {
        let (_dir, root, notes) = workspace();
        for bad in ["..", ".", "../notes", "a/b", ID_A.to_uppercase().as_str()] {
            assert!(restore_notes(&root, &notes, bad).is_err());
            assert!(purge(&root, bad).is_err());
        }
        // A symlink named like an entry is never followed.
        #[cfg(unix)]
        {
            let victim = root.join("victim");
            fs::create_dir_all(&victim).unwrap();
            fs::write(victim.join("keep"), "x").unwrap();
            fs::create_dir_all(root.join(TRASH_DIR)).unwrap();
            std::os::unix::fs::symlink(&victim, root.join(TRASH_DIR).join(ID_B)).unwrap();
            assert!(purge(&root, ID_B).is_err());
            assert!(victim.join("keep").exists());
            assert_eq!(empty(&root), 0);
            assert!(victim.join("keep").exists());
        }
    }

    #[test]
    fn prune_only_removes_old_entries_that_match_the_pattern() {
        let (_dir, root, _notes) = workspace();
        let day = 86_400;
        let now = 1_700_000_000 + 40 * day;

        let old = format!("{}-{}", now - 31 * day, "c".repeat(32));
        let recent = format!("{}-{}", now - 29 * day, "d".repeat(32));
        write_entry_for_test(&root, &old, "note", "old.md", b"o");
        write_entry_for_test(&root, &recent, "note", "recent.md", b"r");
        // Not entries: must survive even though they look ancient.
        let trash = root.join(TRASH_DIR);
        fs::create_dir_all(trash.join("not-an-entry")).unwrap();
        fs::write(trash.join("not-an-entry/keep.txt"), "k").unwrap();
        fs::write(trash.join("readme.txt"), "k").unwrap();
        fs::create_dir_all(trash.join("1000000000-SHORT")).unwrap();

        assert_eq!(prune(&root, now, RETENTION_DAYS), 1);
        assert!(!trash.join(&old).exists());
        assert!(trash.join(&recent).exists());
        assert!(trash.join("not-an-entry/keep.txt").exists());
        assert!(trash.join("readme.txt").exists());
        assert!(trash.join("1000000000-SHORT").exists());

        // Emptying likewise only removes real entries.
        assert_eq!(empty(&root), 1);
        assert!(trash.join("not-an-entry/keep.txt").exists());
        assert!(trash.join("readme.txt").exists());
    }

    #[test]
    fn missing_or_garbled_manifests_are_listed_as_nothing_and_not_deleted() {
        let (_dir, root, _notes) = workspace();
        let dir = root.join(TRASH_DIR).join(ID_A);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), "{ not json").unwrap();
        fs::write(dir.join(ITEM_NAME), "precious").unwrap();
        assert!(list(&root).is_empty());
        assert!(
            dir.join(ITEM_NAME).exists(),
            "unreadable entries are left for the user"
        );
    }

    #[test]
    fn table_entries_round_trip_and_duplicates_are_consumed() {
        let (_dir, root, _notes) = workspace();
        let mut table = WordTable::new("verbs");
        table.add_entry(crate::model::WordEntry::new("kala"));
        let file = root.join("dictionary").join("verbs");
        write_json(&file, &table).unwrap();

        let record = trash_table(&root, &table, &file).unwrap();
        assert!(!file.exists());
        assert_eq!(record.kind, TrashKind::Table);
        assert_eq!(read_table(&root, &record.id).unwrap(), table);

        // A different version of the table does not consume the entry…
        let mut other = table.clone();
        other.add_entry(crate::model::WordEntry::new("extra"));
        consume_table(&root, &other);
        assert_eq!(list(&root).len(), 1);
        // …the identical table does.
        consume_table(&root, &table);
        assert!(list(&root).is_empty());
    }
}
