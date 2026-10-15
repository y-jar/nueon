//! Per-glyph outline files for the writing system.

use std::collections::HashSet;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use super::storage::{self, StorageError};
use super::Workspace;
use crate::config::{
    parse_svg_path, svg_path_data, to_svg_document, to_svg_symbol, transform_contour,
    validate_components, validate_outline, BackImage, Contour, GlyphOutline, OutlineElement,
};
use crate::font::{
    blocks_export, compile_font, plan_layout, read_back, shape_text, validate_glyphs, Direction,
    FontError, FontGlyph, FontIssue, FontReport, FontSettings, ShapedRun,
};
use crate::model::{pathfinder_apply, BooleanOp};

/// Whether a glyph id is safe to use as a file name.
fn valid_glyph_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Largest tracing image accepted on the back layer; larger files import only
/// after the UI has warned about them (`force`).
pub const MAX_BACK_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

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

    /// The directory holding back-layer tracing images.
    pub fn writing_assets_dir(&self) -> PathBuf {
        self.root_path
            .join(storage::WRITING_DIR)
            .join(super::assets::ASSETS_DIR)
    }

    /// Read the first `n` bytes of a file, or fewer when it is shorter.
    fn read_head(source: &std::path::Path, n: usize) -> Result<Vec<u8>, StorageError> {
        use std::io::Read;
        let mut file = std::fs::File::open(source).map_err(|e| storage::io_err(source, e))?;
        let mut head = vec![0u8; n];
        let mut filled = 0;
        while filled < n {
            let read = file
                .read(&mut head[filled..])
                .map_err(|e| storage::io_err(source, e))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        head.truncate(filled);
        Ok(head)
    }

    /// Whether the bytes look like a raster format the back layer accepts.
    /// SVG is deliberately not sniffed in: it would need sanitising first.
    fn looks_like_raster(head: &[u8]) -> bool {
        head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
            || head.starts_with(&[0xFF, 0xD8, 0xFF])
            || (head.len() >= 12
                && &head[..4] == b"RIFF".as_slice()
                && &head[8..12] == b"WEBP".as_slice())
    }

    /// Import a tracing image for one glyph into `writing/assets/` and set it
    /// as the glyph's back image, fitted to the em box by default. The asset
    /// store dedupes identical bytes, so two glyphs sharing a scan share one
    /// file. `force` lets a file above [`MAX_BACK_IMAGE_BYTES`] through.
    pub fn import_back_image(
        &self,
        id: &str,
        source: &std::path::Path,
        force: bool,
    ) -> Result<BackImage, StorageError> {
        if !valid_glyph_id(id) {
            return Err(StorageError::UnsafePath(PathBuf::from(id)));
        }
        let meta = std::fs::metadata(source).map_err(|e| storage::io_err(source, e))?;
        if !meta.is_file() {
            return Err(StorageError::NotAFile(source.to_path_buf()));
        }
        if meta.len() > MAX_BACK_IMAGE_BYTES && !force {
            return Err(StorageError::TooLarge(source.to_path_buf()));
        }
        if !Self::looks_like_raster(&Self::read_head(source, 12)?) {
            return Err(StorageError::Config(
                "writing".to_string(),
                format!(
                    "unsupported back-image format (png, jpg or webp): {}",
                    source.display()
                ),
            ));
        }
        let imported =
            super::assets::import_asset(&self.root_path.join(storage::WRITING_DIR), source)?;
        let mut outline = self.load_glyph(id)?.unwrap_or_default();
        let settings = self.font_settings();
        let image = BackImage {
            asset: imported.name,
            width: f64::from(self.writing.upem),
            x: f64::from(self.writing.upem) / 2.0,
            y: (settings.ascender + settings.descender) / 2.0,
        };
        outline.back_image = Some(image.clone());
        self.save_glyph(id, &outline)?;
        Ok(image)
    }

    /// The absolute path of a glyph's back image file, or `None`.
    pub fn back_image_path(&self, id: &str) -> Result<Option<PathBuf>, StorageError> {
        if !valid_glyph_id(id) {
            return Err(StorageError::UnsafePath(PathBuf::from(id)));
        }
        Ok(self
            .load_glyph(id)?
            .and_then(|outline| outline.back_image)
            .map(|image| self.writing_assets_dir().join(image.asset)))
    }

    /// Drop the outline files of glyphs whose metas vanished from the writing
    /// config, and any back-image asset no remaining outline still references.
    /// Called from the writing `config_set` arm, so the UI's delete flows sweep
    /// through the same path.
    pub fn sweep_deleted_glyphs(&self, previous_ids: &[String]) {
        let current: HashSet<&str> = self.writing.glyphs.iter().map(|g| g.id.as_str()).collect();
        let vanished: Vec<&String> = previous_ids
            .iter()
            .filter(|id| !current.contains(id.as_str()))
            .collect();
        if vanished.is_empty() {
            return;
        }
        let mut orphan_assets: Vec<String> = Vec::new();
        for id in vanished {
            if let Ok(Some(outline)) = self.load_glyph(id) {
                if let Some(image) = outline.back_image {
                    orphan_assets.push(image.asset);
                }
            }
            let _ = std::fs::remove_file(self.glyph_file(id));
        }
        let referenced: HashSet<String> = self
            .scan_glyphs()
            .unwrap_or_default()
            .iter()
            .filter_map(|(_, outline)| outline.back_image.as_ref().map(|image| image.asset.clone()))
            .collect();
        for asset in orphan_assets {
            if !referenced.contains(&asset) {
                let _ = std::fs::remove_file(self.writing_assets_dir().join(asset));
            }
        }
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
            back_image: None,
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
            back_image: None,
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
                back_image: None,
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
            back_image: None,
            elements: contours.into_iter().map(OutlineElement::Contour).collect(),
            advance: original.advance,
            lsb: original.lsb,
            rsb: original.rsb,
        };
        self.save_glyph(id, &outline)?;
        Ok(count)
    }

    fn font_glyphs(&self) -> Result<Vec<FontGlyph>, StorageError> {
        let mut glyphs = Vec::with_capacity(self.writing.glyphs.len());
        for meta in &self.writing.glyphs {
            let outline = self.load_glyph(&meta.id)?.unwrap_or_default();
            glyphs.push(FontGlyph {
                meta: meta.clone(),
                contours: self.flatten_glyph(&meta.id)?,
                advance: outline.advance,
            });
        }
        Ok(glyphs)
    }

    /// Check every glyph for problems a font export would hit. Nothing is written.
    pub fn validate_writing_font(&self) -> Result<Vec<FontIssue>, StorageError> {
        let glyphs = self.font_glyphs()?;
        let mut issues = validate_glyphs(&glyphs);
        let (_, rule_issues) = plan_layout(&glyphs, &self.writing.rules, &self.phonology.phonemes);
        issues.extend(rule_issues);
        Ok(issues)
    }

    fn font_settings(&self) -> FontSettings {
        let config = &self.writing;
        FontSettings {
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
            rules: config.rules.clone(),
            phonemes: self.phonology.phonemes.clone(),
        }
    }

    /// A short hash of everything the compiled font depends on: every glyph's
    /// metadata, outline and advance, the writing config and the inventory. Two
    /// equal keys mean the same font, so a preview can reuse its compiled bytes.
    pub fn writing_font_key(&self) -> Result<String, StorageError> {
        let glyphs = self.font_glyphs()?;
        let parts: Vec<serde_json::Value> = glyphs
            .iter()
            .map(|g| serde_json::json!([g.meta, g.contours, g.advance]))
            .collect();
        let settings = self.font_settings();
        let input = serde_json::json!([
            parts,
            self.writing.rules,
            self.writing.upem,
            settings.ascender,
            settings.descender,
            settings.x_height,
            settings.cap_height,
            self.phonology.phonemes,
        ]);
        let digest = Sha256::digest(input.to_string().as_bytes());
        Ok(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
    }

    /// Compile the font for the type preview. Unlike an export it is not blocked
    /// by validation warnings or a rule that names a missing glyph (such rules
    /// are skipped), so a half-finished system still previews. Returns the font
    /// bytes and the user glyph id behind each font glyph id (`""` for `.notdef`
    /// and the hidden letters the rules need).
    pub fn compile_preview_font(&self) -> Result<(Vec<u8>, Vec<String>), StorageError> {
        let glyphs = self.font_glyphs()?;
        let (bytes, _) = compile_font(&self.font_settings(), &glyphs)
            .map_err(|err| StorageError::Config("font".to_string(), err.to_string()))?;
        let mut ids = vec![String::new()];
        ids.extend(glyphs.iter().map(|g| g.meta.id.clone()));
        Ok((bytes, ids))
    }

    /// Shape each line of `lines` against `font` (see [`Workspace::compile_preview_font`]).
    pub fn shape_preview(
        font: &[u8],
        lines: &[String],
        direction: Direction,
    ) -> Result<Vec<ShapedRun>, StorageError> {
        lines
            .iter()
            .map(|line| {
                shape_text(font, line, direction)
                    .map_err(|err| StorageError::Config("font".to_string(), err.to_string()))
            })
            .collect()
    }

    /// Compile every glyph into a TrueType font, verify it by reading it back,
    /// and return the bytes with a report. Nothing is written to disk here.
    pub fn compile_writing_font(&self) -> Result<(Vec<u8>, FontReport), StorageError> {
        let config = &self.writing;
        let glyphs = self.font_glyphs()?;
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
            rules: config.rules.clone(),
            phonemes: self.phonology.phonemes.clone(),
        };
        let font_error = |err: FontError| StorageError::Config("font".to_string(), err.to_string());
        let (_, rule_issues) = plan_layout(&glyphs, &settings.rules, &settings.phonemes);
        let blockers: Vec<String> = validate_glyphs(&glyphs)
            .into_iter()
            .chain(rule_issues)
            .filter(|issue| blocks_export(std::slice::from_ref(issue)))
            .map(|issue| format!("{}: {}", issue.name, issue.message))
            .collect();
        if !blockers.is_empty() {
            return Err(StorageError::Config(
                "font".to_string(),
                format!("fix before exporting: {}", blockers.join("; ")),
            ));
        }
        let (bytes, report) = compile_font(&settings, &glyphs).map_err(font_error)?;
        let check = read_back(&bytes).map_err(font_error)?;
        let expected = glyphs.len() + report.source_glyphs;
        if check.num_glyphs as usize != expected + 1 || check.mapped.len() != expected {
            return Err(StorageError::Config(
                "font".to_string(),
                format!(
                    "validation failed: expected {} glyphs and {} mappings, read back {} and {}",
                    expected + 1,
                    expected,
                    check.num_glyphs,
                    check.mapped.len()
                ),
            ));
        }
        if check.lookups != report.lookups {
            return Err(StorageError::Config(
                "font".to_string(),
                format!(
                    "validation failed: wrote {} layout lookups, read back {}",
                    report.lookups, check.lookups
                ),
            ));
        }
        Ok((bytes, report))
    }
}
