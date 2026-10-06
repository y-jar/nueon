//! Importing external files into a workspace.
//!
//! Dropped images and other files are copied into `<workspace>/assets/` under
//! a short content hash (`ab12cd34ef.png`), which keeps names simple and
//! filesystem-safe and de-duplicates identical files. Dropped text/Markdown
//! files can instead be imported as notes.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::storage::{io_err, rename_noreplace, safe_join, temp_path, StorageError};

/// Directory (at the workspace root) holding imported files.
pub const ASSETS_DIR: &str = "assets";
/// Largest file accepted as an asset.
pub const MAX_ASSET_BYTES: u64 = 50 * 1024 * 1024;
/// Largest text file accepted as a note.
pub const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

/// Hex characters of the content hash used as a file name.
const HASH_CHARS: usize = 10;

/// How the editor should reference an imported file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Image,
    Text,
    Other,
}

/// The result of importing a file into `assets/`.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedAsset {
    /// File name inside `assets/` (`ab12cd34ef.png`).
    pub name: String,
    /// Path relative to the workspace root (`assets/ab12cd34ef.png`).
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

fn short_hash(source: &Path) -> Result<String, StorageError> {
    let mut file = File::open(source).map_err(|e| io_err(source, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| io_err(source, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(HASH_CHARS);
    for byte in digest.iter().take(HASH_CHARS.div_ceil(2)) {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex.truncate(HASH_CHARS);
    Ok(hex)
}

/// Copy `source` into `<root>/assets/` under its content hash.
pub fn import_asset(root: &Path, source: &Path) -> Result<ImportedAsset, StorageError> {
    check_regular_file(source, MAX_ASSET_BYTES)?;
    let hash = short_hash(source)?;
    let extension = safe_extension(source);
    let name = if extension.is_empty() {
        hash
    } else {
        format!("{hash}.{extension}")
    };

    let dir = root.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    let destination = dir.join(&name);
    let mut existed = destination.exists();
    if !existed {
        // Copy to a unique temp file beside the target, then move it into
        // place without replacing anything: a crash never leaves a
        // half-written asset under its final name, and two imports of the
        // same bytes at once cannot trample each other's temp file.
        let temp = temp_path(&destination);
        fs::copy(source, &temp).map_err(|e| io_err(source, e))?;
        match rename_noreplace(&temp, &destination) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                // Same name means same content hash: the other import won.
                let _ = fs::remove_file(&temp);
                existed = true;
            }
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(io_err(&destination, err));
            }
        }
    }

    Ok(ImportedAsset {
        relative: format!("{ASSETS_DIR}/{name}"),
        kind: classify(source),
        original_name: source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone()),
        name,
        existed,
    })
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

    #[test]
    fn imports_with_short_hash_name_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("My Photo (1).PNG");
        fs::write(&src, b"image-bytes").unwrap();
        let root = dir.path().join("ws");

        let first = import_asset(&root, &src).unwrap();
        assert_eq!(first.kind, AssetKind::Image);
        assert!(!first.existed);
        assert!(first.name.ends_with(".png"));
        assert_eq!(first.name.len(), HASH_CHARS + ".png".len());
        assert!(root.join(&first.relative).exists());
        assert_eq!(first.original_name, "My Photo (1).PNG");

        // Same bytes under another name land on the same asset.
        let twin = dir.path().join("copy.png");
        fs::write(&twin, b"image-bytes").unwrap();
        let second = import_asset(&root, &twin).unwrap();
        assert!(second.existed);
        assert_eq!(second.name, first.name);

        // Different bytes get a different name.
        let other = dir.path().join("other.png");
        fs::write(&other, b"different").unwrap();
        assert_ne!(import_asset(&root, &other).unwrap().name, first.name);

        // No temp files remain.
        let leftovers = fs::read_dir(root.join(ASSETS_DIR))
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
    fn rejects_directories_and_odd_extensions_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        assert!(matches!(
            import_asset(&root, dir.path()),
            Err(StorageError::NotAFile(_))
        ));
        assert!(matches!(
            import_asset(&root, &dir.path().join("missing.png")),
            Err(StorageError::Io { .. })
        ));

        let weird = dir.path().join("data.a b!");
        fs::write(&weird, b"x").unwrap();
        let imported = import_asset(&root, &weird).unwrap();
        assert_eq!(imported.name.len(), HASH_CHARS);
        assert_eq!(imported.kind, AssetKind::Other);
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
        let root = Arc::new(dir.path().join("ws"));
        let src = dir.path().join("pic.png");
        fs::write(&src, b"same-bytes").unwrap();
        let barrier = Arc::new(Barrier::new(10));
        let handles: Vec<_> = (0..10)
            .map(|_| {
                let (root, src, barrier) = (Arc::clone(&root), src.clone(), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    barrier.wait();
                    import_asset(&root, &src).unwrap().name
                })
            })
            .collect();
        let names: std::collections::BTreeSet<_> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(names.len(), 1);
        let files: Vec<_> = fs::read_dir(root.join(ASSETS_DIR)).unwrap().collect();
        assert_eq!(files.len(), 1, "one asset and no leftover temp files");
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
