//! Directory scanning for the notes tree.

use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

/// A node in the notes tree.
#[derive(Debug, Clone, Serialize)]
pub struct NoteNode {
    pub name: String,
    /// Path relative to `notes/`, using `/` separators.
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<NoteNode>,
}

/// Scan `notes_dir` recursively. Every entry is shown, including dotfiles and
/// dotfolders, so the tree mirrors the directory exactly.
pub fn scan(notes_dir: &Path) -> io::Result<Vec<NoteNode>> {
    if !notes_dir.exists() {
        return Ok(Vec::new());
    }
    read_dir(notes_dir, Path::new(""))
}

fn read_dir(abs: &Path, rel: &Path) -> io::Result<Vec<NoteNode>> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(abs)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type()?.is_dir();
        let child_rel = rel.join(&name);
        let children = if is_dir {
            read_dir(&entry.path(), &child_rel)?
        } else {
            Vec::new()
        };
        nodes.push(NoteNode {
            name,
            path: child_rel.to_string_lossy().replace('\\', "/"),
            is_dir,
            children,
        });
    }
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(nodes)
}
