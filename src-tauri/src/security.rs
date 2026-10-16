//! Choosing file paths on the Rust side: dialogs run here (callback API, so
//! no thread blocks), reads keep their size cap, writes check their size and
//! extension, and paths the OS handed the app (drag-dropped files) are
//! recorded as one-use grants. A path string sent from JavaScript is never
//! trusted on its own; the I/O functions that do take a path are plain and
//! unit-tested, and the commands on top of them are thin.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// Largest file read from disk (an imported SVG, a dropped file).
pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// Largest file written to disk (an exported font or SVG).
pub const MAX_WRITE_BYTES: u64 = 50 * 1024 * 1024;

/// An open-file dialog, resolved when the user closes it. The callback API
/// never blocks a thread, so the app stays live while the dialog is up.
pub async fn pick_open_file(
    app: &AppHandle,
    filters: &[(&str, &[&str])],
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file();
    for (name, extensions) in filters {
        dialog = dialog.add_filter(*name, extensions);
    }
    dialog.pick_file(move |file| {
        let picked = file.and_then(|f| f.into_path().ok());
        let _ = tx.send(picked);
    });
    rx.await.map_err(|err| err.to_string())
}

/// A save-file dialog with a suggested name, resolved when the user closes it.
pub async fn pick_save_file(
    app: &AppHandle,
    filters: &[(&str, &[&str])],
    default_name: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file();
    for (name, extensions) in filters {
        dialog = dialog.add_filter(*name, extensions);
    }
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(name);
    }
    dialog.save_file(move |file| {
        let picked = file.and_then(|f| f.into_path().ok());
        let _ = tx.send(picked);
    });
    rx.await.map_err(|err| err.to_string())
}

/// Read a text file, refusing anything above [`MAX_READ_BYTES`].
pub fn read_text_capped(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|err| format!("{path:?}: {err}"))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "file is too large to read (over {} MB)",
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    std::fs::read_to_string(path).map_err(|err| format!("{path:?}: {err}"))
}

/// Append the expected extension when the user typed a bare name, and refuse
/// a different one: a `.ttf`-filtered dialog should not write `evil.bat`.
pub fn ensure_extension(path: PathBuf, extension: &str) -> Result<PathBuf, String> {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case(extension) => Ok(path),
        Some(ext) => Err(format!(
            "refusing to write .{ext} where .{extension} was asked"
        )),
        None => Ok(path.with_extension(extension)),
    }
}

/// Write bytes to a path the Rust side chose, refusing writes above
/// [`MAX_WRITE_BYTES`] and any extension but the expected one.
pub fn write_bytes_checked(path: &Path, bytes: &[u8], extension: &str) -> Result<PathBuf, String> {
    if bytes.len() as u64 > MAX_WRITE_BYTES {
        return Err(format!(
            "refusing to write more than {} MB",
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let path = ensure_extension(path.to_path_buf(), extension)?;
    std::fs::write(&path, bytes).map_err(|err| format!("{path:?}: {err}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_extension_appends_the_expected_one() {
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/glyph"), "svg").unwrap(),
            PathBuf::from("/tmp/glyph.svg")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/glyph.SVG"), "svg").unwrap(),
            PathBuf::from("/tmp/glyph.SVG"),
            "the check is case-insensitive and keeps the user's name"
        );
    }

    #[test]
    fn ensure_extension_refuses_a_different_one() {
        assert!(ensure_extension(PathBuf::from("/tmp/font.ttf"), "svg").is_err());
        assert!(ensure_extension(PathBuf::from("/tmp/none.bat"), "ttf").is_err());
    }

    #[test]
    fn read_text_capped_keeps_the_limit_and_refuses_directories() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_text_capped(dir.path()).is_err(),
            "a directory is not a file"
        );
        let file = dir.path().join("note.txt");
        std::fs::write(&file, "hello").unwrap();
        assert_eq!(read_text_capped(&file).unwrap(), "hello");
        assert!(read_text_capped(&dir.path().join("missing.txt")).is_err());
        let big = dir.path().join("big.txt");
        let mut bytes = Vec::new();
        bytes.resize(MAX_READ_BYTES as usize + 1, b'x');
        std::fs::write(&big, bytes).unwrap();
        assert!(read_text_capped(&big).is_err(), "the read cap holds");
    }

    #[test]
    fn write_bytes_checked_writes_extends_and_caps() {
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("glyph");
        let written = write_bytes_checked(&bare, b"<svg/>".as_slice(), "svg").unwrap();
        assert_eq!(written, dir.path().join("glyph.svg"));
        assert_eq!(std::fs::read(&written).unwrap(), b"<svg/>");

        let wrong = dir.path().join("font.ttf");
        assert!(write_bytes_checked(&wrong, b"x".as_slice(), "svg").is_err());
        assert!(!wrong.exists(), "nothing was written on refusal");

        let mut huge = Vec::new();
        huge.resize(MAX_WRITE_BYTES as usize + 1, b'x');
        assert!(
            write_bytes_checked(&dir.path().join("huge.svg"), &huge, "svg").is_err(),
            "the write cap holds"
        );
    }
}
