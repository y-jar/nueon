//! Per-glyph outline files for the writing system.

use std::collections::HashSet;
use std::path::PathBuf;

use super::storage::{self, StorageError};
use super::Workspace;
use crate::config::{
    parse_svg_path, svg_path_data, to_svg_document, to_svg_symbol, transform_contour,
    validate_components, validate_outline, Contour, GlyphOutline, OutlineElement,
};
use crate::font::{compile_font, read_back, FontError, FontGlyph, FontReport, FontSettings};
use crate::model::{pathfinder_apply, BooleanOp};

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

    /// Expand a glyph's component instances into a flat list of contours,
    /// applying each instance's transform. Detects reference cycles.
    pub fn flatten_glyph(&self, id: &str) -> Result<Vec<Contour>, StorageError> {
        let mut visiting = HashSet::new();
        self.flatten_into(id, &mut visiting)
    }

    fn flatten_into(
        &self,
        id: &str,
        visiting: &mut HashSet<String>,
    ) -> Result<Vec<Contour>, StorageError> {
        if !visiting.insert(id.to_string()) {
            return Err(StorageError::Config(
                id.to_string(),
                "component cycle".to_string(),
            ));
        }
        let outline = self.load_glyph(id)?.unwrap_or_default();
        let mut contours = Vec::new();
        for element in &outline.elements {
            match element {
                OutlineElement::Contour(contour) => contours.push(contour.clone()),
                OutlineElement::Component(component) => {
                    for sub in self.flatten_into(&component.glyph, visiting)? {
                        contours.push(transform_contour(&sub, component));
                    }
                }
            }
        }
        visiting.remove(id);
        Ok(contours)
    }

    /// Apply a pathfinder boolean to a glyph's flattened contours and save.
    pub fn apply_pathfinder(&self, id: &str, op: BooleanOp) -> Result<(), StorageError> {
        let original = self.load_glyph(id)?.unwrap_or_default();
        let contours = self.flatten_glyph(id)?;
        if contours.is_empty() {
            return Err(StorageError::Config(
                id.to_string(),
                "glyph has no geometry to operate on".to_string(),
            ));
        }
        let result = pathfinder_apply(&contours, op);
        let outline = GlyphOutline {
            elements: result.into_iter().map(OutlineElement::Contour).collect(),
            advance: original.advance,
            lsb: original.lsb,
            rsb: original.rsb,
        };
        self.save_glyph(id, &outline)
    }

    /// One glyph as a standalone SVG document (components expanded).
    pub fn export_glyph_svg(&self, id: &str) -> Result<String, StorageError> {
        let contours = self.flatten_glyph(id)?;
        let outline = GlyphOutline {
            elements: contours.into_iter().map(OutlineElement::Contour).collect(),
            ..GlyphOutline::default()
        };
        Ok(to_svg_document(&outline))
    }

    /// Every glyph in the writing config as one `<symbol>` sprite sheet.
    pub fn export_sprite_svg(&self) -> Result<String, StorageError> {
        let mut out = String::from("<svg xmlns=\"http://www.w3.org/2000/svg\">");
        for glyph in &self.writing.glyphs {
            let contours = self.flatten_glyph(&glyph.id)?;
            let outline = GlyphOutline {
                elements: contours.into_iter().map(OutlineElement::Contour).collect(),
                ..GlyphOutline::default()
            };
            out.push_str(&to_svg_symbol(&format!("glyph-{}", glyph.id), &outline));
        }
        out.push_str("</svg>");
        Ok(out)
    }

    /// Replace a glyph's contours with the paths found in an SVG document,
    /// keeping its metrics. Returns how many contours were imported.
    pub fn import_glyph_svg(&self, id: &str, svg: &str) -> Result<usize, StorageError> {
        let paths = svg_path_data(svg);
        if paths.is_empty() {
            return Err(StorageError::Config(
                id.to_string(),
                "no <path d=\"...\"> found in the SVG".to_string(),
            ));
        }
        let mut contours = Vec::new();
        for d in &paths {
            contours.extend(
                parse_svg_path(d).map_err(|err| StorageError::Config(id.to_string(), err))?,
            );
        }
        if contours.is_empty() {
            return Err(StorageError::Config(
                id.to_string(),
                "the SVG paths contain no drawable shapes".to_string(),
            ));
        }
        let count = contours.len();
        let original = self.load_glyph(id)?.unwrap_or_default();
        let outline = GlyphOutline {
            elements: contours.into_iter().map(OutlineElement::Contour).collect(),
            advance: original.advance,
            lsb: original.lsb,
            rsb: original.rsb,
        };
        self.save_glyph(id, &outline)?;
        Ok(count)
    }

    /// Compile every glyph into a TrueType font, verify it by reading it back,
    /// and return the bytes with a report. Nothing is written to disk here.
    pub fn compile_writing_font(&self) -> Result<(Vec<u8>, FontReport), StorageError> {
        let config = &self.writing;
        let mut glyphs = Vec::with_capacity(config.glyphs.len());
        for meta in &config.glyphs {
            let outline = self.load_glyph(&meta.id)?.unwrap_or_default();
            glyphs.push(FontGlyph {
                meta: meta.clone(),
                contours: self.flatten_glyph(&meta.id)?,
                advance: outline.advance,
            });
        }
        let settings = FontSettings {
            family: self.language.name.clone(),
            upem: config.upem,
            ascender: if config.ascender != 0.0 {
                config.ascender
            } else {
                800.0
            },
            descender: if config.descender != 0.0 {
                config.descender
            } else {
                -200.0
            },
            x_height: config.x_height,
            cap_height: config.cap_height,
        };
        let font_error = |err: FontError| StorageError::Config("font".to_string(), err.to_string());
        let (bytes, report) = compile_font(&settings, &glyphs).map_err(font_error)?;
        let check = read_back(&bytes).map_err(font_error)?;
        if check.num_glyphs as usize != glyphs.len() + 1 || check.mapped.len() != glyphs.len() {
            return Err(StorageError::Config(
                "font".to_string(),
                format!(
                    "validation failed: expected {} glyphs and {} mappings, read back {} and {}",
                    glyphs.len() + 1,
                    glyphs.len(),
                    check.num_glyphs,
                    check.mapped.len()
                ),
            ));
        }
        Ok((bytes, report))
    }
}
