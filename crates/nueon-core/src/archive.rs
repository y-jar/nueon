//! Zip a whole workspace directory, excluding version-control internals.

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Errors raised while archiving a workspace.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("failed to read the workspace: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to write the archive: {0}")]
    Zip(#[from] zip::result::ZipError),
}

/// Write every file under `root` into a zip at `dest`, skipping the `.git`
/// directory so a shared archive never leaks repository internals.
pub fn zip_workspace(root: &Path, dest: &Path) -> Result<(), ArchiveError> {
    let mut writer = ZipWriter::new(File::create(dest)?);
    add_dir(&mut writer, root, root)?;
    writer.finish()?;
    Ok(())
}

fn add_dir(writer: &mut ZipWriter<File>, base: &Path, dir: &Path) -> Result<(), ArchiveError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if dir == base && entry.file_name() == OsStr::new(".git") {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            add_dir(writer, base, &path)?;
        } else if file_type.is_file() {
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            writer.start_file(rel, options)?;
            writer.write_all(&fs::read(&path)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zips_the_workspace_and_skips_git() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "hi").unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "secret").unwrap();

        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("ws.zip");
        zip_workspace(root.path(), &dest).unwrap();

        let mut archive = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"notes/a.md".to_string()), "{names:?}");
        assert!(
            !names.iter().any(|name| name.starts_with(".git")),
            "{names:?}"
        );
    }
}
