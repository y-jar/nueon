//! Per-glyph outline files for the writing system.

use std::path::PathBuf;

use super::storage::{self, StorageError};
use super::Workspace;
use crate::config::{validate_components, validate_outline, GlyphOutline};

/// Whether a glyph id is safe to use as a file name.
fn valid_glyph_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

impl Workspace {
    /// The directory holding per-glyph outline files.
    pub fn glyphs_dir(&self) -> PathBuf {
        self.root_path
            .join(storage::WRITING_DIR)
            .join(storage::GLYPHS_DIR)
    }

    /// The backing file for one glyph's outline.
    pub fn glyph_file(&self, id: &str) -> PathBuf {
        self.glyphs_dir().join(id)
    }

    /// Load every glyph outline on disk, keyed by glyph id.
    fn scan_glyphs(&self) -> Result<Vec<(String, GlyphOutline)>, StorageError> {
        let dir = self.glyphs_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut glyphs = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| storage::io_err(&dir, e))? {
            let entry = entry.map_err(|e| storage::io_err(&dir, e))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !valid_glyph_id(&id) {
                continue;
            }
            let outline: GlyphOutline = storage::read_json(&path)?;
            glyphs.push((id, outline));
        }
        glyphs.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(glyphs)
    }

    /// Load one glyph's outline, or `None` when it has not been written yet.
    pub fn load_glyph(&self, id: &str) -> Result<Option<GlyphOutline>, StorageError> {
        if !valid_glyph_id(id) {
            return Err(StorageError::UnsafePath(PathBuf::from(id)));
        }
        storage::load_json(&self.glyph_file(id))
    }

    /// Save one glyph's outline atomically, rejecting writes that would leave
    /// the component graph cyclic or dangling.
    pub fn save_glyph(&self, id: &str, outline: &GlyphOutline) -> Result<(), StorageError> {
        if !valid_glyph_id(id) {
            return Err(StorageError::UnsafePath(PathBuf::from(id)));
        }
        validate_outline(outline).map_err(|err| StorageError::Config(id.to_string(), err))?;

        // Build the prospective full graph: every glyph on disk, with this one
        // inserted or replaced, and reject any cycle or dangling reference.
        let mut glyphs = self.scan_glyphs()?;
        match glyphs.iter_mut().find(|(existing, _)| existing == id) {
            Some((_, existing)) => *existing = outline.clone(),
            None => glyphs.push((id.to_string(), outline.clone())),
        }
        let refs: Vec<(String, &GlyphOutline)> = glyphs
            .iter()
            .map(|(glyph_id, outline)| (glyph_id.clone(), outline))
            .collect();
        validate_components(&refs).map_err(|err| StorageError::Config(id.to_string(), err))?;

        storage::save_json(&self.glyph_file(id), outline)
    }
}
