//! Importing editor-inserted files into a workspace.
//!
//! Images inserted from the editor (toolbar, paste, or drop on the editor) are
//! copied into `<workspace>/notes/assets/` under a sanitized, link-safe name —
//! `My-Photo.png`, `My-Photo 2.png` on a clash. Files dropped on the notes tree
//! are handled separately by `storage::copy_into`, which keeps their own name.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use super::storage::{io_err, rename_noreplace, temp_path, StorageError};

/// Directory (inside `notes/`) holding imported files.
pub const ASSETS_DIR: &str = "assets";
/// Largest file accepted as an asset.
pub const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;

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
    fn classifies_files_by_extension() {
        assert_eq!(classify(Path::new("a.JPG")), AssetKind::Image);
        assert_eq!(classify(Path::new("a.csv")), AssetKind::Text);
        assert_eq!(classify(Path::new("a.zip")), AssetKind::Other);
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
}
