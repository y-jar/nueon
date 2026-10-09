//! Importing external files into a workspace.
//!
//! Dropped images and other files are copied into `<workspace>/notes/assets/`
//! under their own (sanitized) name — `My-Photo.png`, `My-Photo 2.png` on a
//! clash — so the folder is recognizable in the notes tree. Dropped
//! text/Markdown files can instead be imported as notes.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::storage::{io_err, rename_noreplace, safe_join, temp_path, StorageError};

/// Directory (inside `notes/`) holding imported files.
pub const ASSETS_DIR: &str = "assets";
/// Largest file accepted as an asset.
pub const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;
/// Largest text file accepted as a note.
pub const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

/// Longest sanitized asset file name, before the extension.
const MAX_STEM_CHARS: usize = 64;

/// How the editor should reference an imported file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Image,
    Text,
    Other,
}

/// The result of importing a file into `notes/assets/`.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedAsset {
    /// File name inside `notes/assets/` (`My-Photo.png`).
    pub name: String,
    /// Path relative to the `notes/` directory (`assets/My-Photo.png`).
    pub relative: String,
    pub kind: AssetKind,
    /// The original file name, for link text.
    pub original_name: String,
    /// Whether an identical file was already present.
    pub existed: bool,
}

/// Lowercase alphanumeric extension (at most 8 chars), or empty.
fn safe_extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_default()
}

/// Classify a file by its extension.
pub fn classify(path: &Path) -> AssetKind {
    match safe_extension(path).as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" => AssetKind::Image,
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "log" => AssetKind::Text,
        _ => AssetKind::Other,
    }
}

/// Whether a dropped file should become a note when dropped on the explorer.
pub fn is_note_source(path: &Path) -> bool {
    matches!(safe_extension(path).as_str(), "md" | "markdown" | "txt")
}

fn check_regular_file(source: &Path, limit: u64) -> Result<u64, StorageError> {
    // `metadata` follows symlinks, so a link to a directory is rejected too.
    let meta = fs::metadata(source).map_err(|e| io_err(source, e))?;
    if !meta.is_file() {
        return Err(StorageError::NotAFile(source.to_path_buf()));
    }
    if meta.len() > limit {
        return Err(StorageError::TooLarge(source.to_path_buf()));
    }
    Ok(meta.len())
}

/// A filesystem- and Markdown-safe stem: letters, digits, `_`, `.` and `-`
/// kept, everything else collapsed to `-`, leading/trailing separators trimmed.
fn sanitize_stem(stem: Option<&OsStr>) -> String {
    let raw = stem
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = String::new();
    let mut last_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    let limited: String = trimmed.chars().take(MAX_STEM_CHARS).collect();
    if limited.is_empty() {
        "file".to_string()
    } else {
        limited
    }
}

/// Whether two files hold identical bytes.
fn files_equal(a: &Path, b: &Path) -> Result<bool, StorageError> {
    let size_a = fs::metadata(a).map_err(|e| io_err(a, e))?.len();
    let size_b = fs::metadata(b).map_err(|e| io_err(b, e))?.len();
    if size_a != size_b {
        return Ok(false);
    }
    let mut file_a = File::open(a).map_err(|e| io_err(a, e))?;
    let mut file_b = File::open(b).map_err(|e| io_err(b, e))?;
    let mut buf_a = [0u8; 64 * 1024];
    let mut buf_b = [0u8; 64 * 1024];
    loop {
        let read_a = file_a.read(&mut buf_a).map_err(|e| io_err(a, e))?;
        let read_b = file_b.read(&mut buf_b).map_err(|e| io_err(b, e))?;
        if read_a != read_b || buf_a[..read_a] != buf_b[..read_b] {
            return Ok(false);
        }
        if read_a == 0 {
            return Ok(true);
        }
    }
}

/// Copy `source` into `<notes>/assets/` under a readable name derived from it.
pub fn import_asset(notes_dir: &Path, source: &Path) -> Result<ImportedAsset, StorageError> {
    check_regular_file(source, MAX_ASSET_BYTES)?;

    let extension = safe_extension(source);
    let ext_part = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let stem = sanitize_stem(source.file_stem());
    let original_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("{stem}{ext_part}"));

    let dir = notes_dir.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;

    // Copy to a unique temp file beside the target, then move it into place
    // without replacing anything: a crash never leaves a half-written asset
    // under its final name, and two imports of the same bytes at once cannot
    // trample each other's temp file.
    let temp = temp_path(&dir.join("asset"));
    fs::copy(source, &temp).map_err(|e| io_err(source, e))?;

    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}{ext_part}")
        } else {
            format!("{stem} {n}{ext_part}")
        };
        let destination = dir.join(&name);
        if destination.exists() {
            // Same name and bytes: reuse the existing asset.
            if files_equal(&destination, &temp)? {
                let _ = fs::remove_file(&temp);
                return Ok(ImportedAsset {
                    relative: format!("{ASSETS_DIR}/{name}"),
                    kind: classify(source),
                    original_name,
                    name,
                    existed: true,
                });
            }
            if n < 10_000 {
                n += 1;
                continue;
            }
            let _ = fs::remove_file(&temp);
            return Err(StorageError::AlreadyExists(destination));
        }
        match rename_noreplace(&temp, &destination) {
            Ok(()) => {
                return Ok(ImportedAsset {
                    relative: format!("{ASSETS_DIR}/{name}"),
                    kind: classify(source),
                    original_name,
                    name,
                    existed: false,
                })
            }
            // Lost a race to create this name: re-check it on the next pass,
            // so an identical concurrent import shares the file.
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(io_err(&destination, err));
            }
        }
    }
}

/// Import a text file as a Markdown note inside `folder` (relative to
/// `notes_dir`). Returns the new note's path relative to `notes_dir`.
pub fn import_note(
    notes_dir: &Path,
    folder: &Path,
    source: &Path,
) -> Result<PathBuf, StorageError> {
    check_regular_file(source, MAX_NOTE_BYTES)?;
    let text = fs::read_to_string(source).map_err(|e| io_err(source, e))?;

    let stem: String = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let stem = if stem.trim().is_empty() {
        "imported".to_string()
    } else {
        stem.trim().to_string()
    };

    // Write once to a unique temp file in the destination folder, then try
    // each candidate name with a no-replace move. Two imports (or an import and
    // a new note) racing for one name can never overwrite each other: the loser
    // simply takes the next name.
    let first = safe_join(notes_dir, &folder.join(format!("{stem}.md")))?;
    let parent = first.parent().map(Path::to_path_buf).unwrap_or_default();
    fs::create_dir_all(&parent).map_err(|e| io_err(&parent, e))?;
    let temp = temp_path(&first);
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| io_err(&temp, e))?;
        std::io::Write::write_all(&mut file, text.as_bytes()).map_err(|e| io_err(&temp, e))?;
        file.sync_all().map_err(|e| io_err(&temp, e))?;
    }

    let mut relative = folder.join(format!("{stem}.md"));
    let mut n = 2;
    loop {
        let target = safe_join(notes_dir, &relative)?;
        match rename_noreplace(&temp, &target) {
            Ok(()) => return Ok(relative),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists && n < 10_000 => {
                relative = folder.join(format!("{stem} {n}.md"));
                n += 1;
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

    fn asset_files(notes: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(notes.join(ASSETS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn imports_with_readable_names_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let src = dir.path().join("My Photo.PNG");
        fs::write(&src, b"image-bytes").unwrap();

        let first = import_asset(&notes, &src).unwrap();
        assert_eq!(first.kind, AssetKind::Image);
        assert!(!first.existed);
        assert_eq!(first.name, "My-Photo.png");
        assert_eq!(first.relative, "assets/My-Photo.png");
        assert!(notes.join(&first.relative).exists());
        assert_eq!(first.original_name, "My Photo.PNG");

        // Same bytes under the same name are reused.
        let second = import_asset(&notes, &src).unwrap();
        assert!(second.existed);
        assert_eq!(second.name, "My-Photo.png");
        assert_eq!(asset_files(&notes), ["My-Photo.png"]);

        // Different bytes with the same name take the next free name.
        fs::write(&src, b"different").unwrap();
        let third = import_asset(&notes, &src).unwrap();
        assert!(!third.existed);
        assert_eq!(third.name, "My-Photo 2.png");
    }

    #[test]
    fn rejects_directories_and_sanitizes_odd_names() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        assert!(matches!(
            import_asset(&notes, dir.path()),
            Err(StorageError::NotAFile(_))
        ));
        assert!(matches!(
            import_asset(&notes, &dir.path().join("missing.png")),
            Err(StorageError::Io { .. })
        ));

        let weird = dir.path().join("..weird name!.txt");
        fs::write(&weird, b"x").unwrap();
        let imported = import_asset(&notes, &weird).unwrap();
        assert_eq!(imported.name, "weird-name.txt");
        assert_eq!(imported.kind, AssetKind::Text);
    }

    #[test]
    fn classifies_and_detects_note_sources() {
        assert_eq!(classify(Path::new("a.JPG")), AssetKind::Image);
        assert_eq!(classify(Path::new("a.csv")), AssetKind::Text);
        assert_eq!(classify(Path::new("a.zip")), AssetKind::Other);
        assert!(is_note_source(Path::new("n.MD")));
        assert!(is_note_source(Path::new("n.txt")));
        assert!(!is_note_source(Path::new("n.png")));
    }

    #[test]
    fn concurrent_note_imports_never_overwrite_each_other() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let notes = Arc::new(dir.path().join("notes"));
        fs::create_dir_all(notes.join("lore")).unwrap();
        let n = 12;
        let mut sources = Vec::new();
        for i in 0..n {
            let dir_i = dir.path().join(format!("src{i}"));
            fs::create_dir_all(&dir_i).unwrap();
            let src = dir_i.join("story.txt");
            fs::write(&src, format!("story {i}")).unwrap();
            sources.push(src);
        }
        let barrier = Arc::new(Barrier::new(n));
        let handles: Vec<_> = sources
            .into_iter()
            .map(|src| {
                let (notes, barrier) = (Arc::clone(&notes), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    import_note(&notes, Path::new("lore"), &src).unwrap()
                })
            })
            .collect();
        let mut paths: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), n, "every import got its own note");

        let mut contents: Vec<String> = paths
            .iter()
            .map(|p| fs::read_to_string(notes.join(p)).unwrap())
            .collect();
        contents.sort();
        let mut expected: Vec<String> = (0..n).map(|i| format!("story {i}")).collect();
        expected.sort();
        assert_eq!(contents, expected, "no import lost or overwrote another");
        // No temp files left behind.
        let leftovers = fs::read_dir(notes.join("lore"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn concurrent_imports_of_the_same_asset_share_one_file() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let notes = Arc::new(dir.path().join("notes"));
        let src = dir.path().join("pic.png");
        fs::write(&src, b"same-bytes").unwrap();
        let barrier = Arc::new(Barrier::new(10));
        let handles: Vec<_> = (0..10)
            .map(|_| {
                let (notes, src, barrier) = (Arc::clone(&notes), src.clone(), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    import_asset(&notes, &src).unwrap().name
                })
            })
            .collect();
        let names: std::collections::BTreeSet<_> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(names, ["pic.png".to_string()].into_iter().collect());
        assert_eq!(asset_files(&notes), ["pic.png"], "one asset, no temp files");
    }

    #[test]
    fn imports_text_as_unique_markdown_notes() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        fs::create_dir_all(notes.join("lore")).unwrap();
        let src = dir.path().join("story.txt");
        fs::write(&src, "once upon").unwrap();

        let first = import_note(&notes, Path::new("lore"), &src).unwrap();
        assert_eq!(first, Path::new("lore/story.md"));
        assert_eq!(fs::read_to_string(notes.join(&first)).unwrap(), "once upon");

        let second = import_note(&notes, Path::new("lore"), &src).unwrap();
        assert_eq!(second, Path::new("lore/story 2.md"));

        // Folders cannot escape the notes directory.
        assert!(import_note(&notes, Path::new("../out"), &src).is_err());
    }
}
