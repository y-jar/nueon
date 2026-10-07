//! Markdown note files.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// A single Markdown note file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteFile {
    /// Path relative to the workspace `notes/` directory, e.g. `Grammar/phonology.md`.
    pub path: PathBuf,
    /// Raw Markdown fed into the live-preview renderer.
    #[serde(default)]
    pub raw_content: String,
}

impl NoteFile {
    /// Create a note from a relative path and its raw content.
    pub fn new(path: impl Into<PathBuf>, raw_content: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            raw_content: raw_content.into(),
        }
    }
}
