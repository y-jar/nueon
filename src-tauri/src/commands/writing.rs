//! Writing-system commands: per-glyph outline load and save.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use nueon_core::config::{BackImage, GlyphOutline};
use nueon_core::font::{Direction, FontIssue, ShapedRun};
use nueon_core::model::BooleanOp;

use crate::security::{pick_open_file, pick_save_file, read_text_capped, write_bytes_checked};
use crate::state::AppState;

use super::changed;

type Shared = Mutex<AppState>;

/// Load one glyph's outline, or `None` when it has not been written yet.
#[tauri::command]
pub fn writing_glyph_get(
    state: State<'_, Shared>,
    id: String,
) -> Result<Option<GlyphOutline>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .load_glyph(&id)
        .map_err(|err| err.to_string())
}

/// Save one glyph's outline, rejecting acyclic-component violations.
#[tauri::command]
pub fn writing_glyph_set(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    outline: GlyphOutline,
) -> Result<(), String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .save_glyph(&id, &outline)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(())
}

/// Apply a pathfinder boolean to a glyph's contours.
#[tauri::command]
pub fn writing_path_operation(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    operation: String,
) -> Result<(), String> {
    let op = match operation.as_str() {
        "union" => BooleanOp::Union,
        "difference" => BooleanOp::Difference,
        "intersect" => BooleanOp::Intersect,
        "exclude" => BooleanOp::Exclude,
        other => return Err(format!("unknown pathfinder operation: {other}")),
    };
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .apply_pathfinder(&id, op)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(())
}

/// Pick a tracing image in a dialog run on the Rust side and import it for
/// the glyph. A file above the size limit is refused; the picked path is
/// stashed so [`writing_back_image_confirm`] can retry it with force after
/// the UI has warned the user, without picking the file again.
#[tauri::command]
pub async fn writing_back_image_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> Result<BackImage, String> {
    let Some(path) = pick_open_file(&app, &[("Image", &["png", "jpg", "jpeg", "webp"])]).await?
    else {
        return Err("cancelled".to_string());
    };
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    match state.workspace()?.import_back_image(&id, &path, false) {
        Ok(image) => {
            state.pending_back_image = None;
            drop(state);
            changed(&app, "writing");
            Ok(image)
        }
        Err(err) if err.to_string().contains("too large") => {
            state.pending_back_image = Some((id, path));
            drop(state);
            Err("the tracing image is larger than 10 MB".to_string())
        }
        Err(err) => Err(err.to_string()),
    }
}

/// Retry the tracing image the dialog just picked, with force, after the UI
/// has confirmed the size warning. There is nothing to retry if the stash is
/// empty (or the glyph changed).
#[tauri::command]
pub async fn writing_back_image_confirm(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<BackImage, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let Some((id, path)) = state.pending_back_image.take() else {
        return Err("no tracing image to confirm".to_string());
    };
    let image = state
        .workspace()?
        .import_back_image(&id, &path, true)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(image)
}

/// The absolute path of a glyph's back image file, or `None` when it has none.
#[tauri::command]
pub fn writing_back_image_path(
    state: State<'_, Shared>,
    id: String,
) -> Result<Option<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let path = state
        .workspace()?
        .back_image_path(&id)
        .map_err(|err| err.to_string())?;
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

/// One glyph as a standalone SVG document.
#[tauri::command]
pub fn writing_export_svg(state: State<'_, Shared>, id: String) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_glyph_svg(&id)
        .map_err(|err| err.to_string())
}

/// Every glyph as one `<symbol>` sprite sheet.
#[tauri::command]
pub fn writing_export_sprite(state: State<'_, Shared>) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .export_sprite_svg()
        .map_err(|err| err.to_string())
}

/// Replace a glyph's contours from SVG text; returns how many were imported.
#[tauri::command]
pub fn writing_import_svg(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    svg: String,
) -> Result<usize, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let count = state
        .workspace()?
        .import_glyph_svg(&id, &svg)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(count)
}

/// Import an SVG into the open glyph. The file is chosen in a dialog run on
/// the Rust side (the callback API, so no thread blocks) and read under the
/// 8 MB cap; a path string from JavaScript is never trusted with a read.
#[tauri::command]
pub async fn writing_import_svg_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> Result<usize, String> {
    let Some(path) = pick_open_file(&app, &[("SVG image", &["svg"])]).await? else {
        return Err("cancelled".to_string());
    };
    let svg = read_text_capped(&path)?;
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let count = state
        .workspace()?
        .import_glyph_svg(&id, &svg)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "writing");
    Ok(count)
}

/// Export app-generated SVG text (a glyph document, a sprite sheet): the
/// path is chosen in a dialog run on the Rust side and the write is size-
/// and extension-checked. The text is the app's own output; only the path
/// must never come from JavaScript.
#[tauri::command]
pub async fn writing_export_text_dialog(
    app: AppHandle,
    text: String,
    default_name: String,
) -> Result<String, String> {
    let Some(path) = pick_save_file(&app, &[("SVG image", &["svg"])], Some(&default_name)).await?
    else {
        return Err("cancelled".to_string());
    };
    let written = write_bytes_checked(&path, text.as_bytes(), "svg")?;
    Ok(written.display().to_string())
}

/// Export the open glyph as an SVG document: the path is chosen in a dialog
/// run on the Rust side and the write is size- and extension-checked.
#[tauri::command]
pub async fn writing_export_svg_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> Result<String, String> {
    let svg = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state
            .workspace()?
            .export_glyph_svg(&id)
            .map_err(|err| err.to_string())?
    };
    let Some(path) = pick_save_file(&app, &[("SVG image", &["svg"])], None).await? else {
        return Err("cancelled".to_string());
    };
    let written = write_bytes_checked(&path, svg.as_bytes(), "svg")?;
    changed(&app, "writing");
    Ok(written.display().to_string())
}

/// What a font export wrote.
#[derive(serde::Serialize)]
pub struct FontExport {
    pub glyphs: usize,
    pub mapped: usize,
    pub bytes: usize,
    pub source_glyphs: usize,
    pub lookups: usize,
}

/// Text shaped against the compiled font, for the type preview.
#[derive(serde::Serialize)]
pub struct PreviewShaping {
    /// Hash of everything the font depends on; equal keys mean the same font.
    pub key: String,
    /// The user glyph id behind each font glyph id (`""` for `.notdef` and hidden letters).
    pub glyph_ids: Vec<String>,
    /// One shaped run per input line.
    pub runs: Vec<ShapedRun>,
}

/// Shape lines of text with the font the export would produce. The compiled font
/// is cached by its key, so typing does not recompile.
#[tauri::command]
pub fn writing_preview_shape(
    state: State<'_, Shared>,
    lines: Vec<String>,
    rtl: bool,
) -> Result<PreviewShaping, String> {
    let mut guard = state.lock().map_err(|_| "state poisoned".to_string())?;
    let state = &mut *guard;
    let workspace = state
        .workspace
        .as_ref()
        .ok_or_else(|| "no workspace is open".to_string())?;
    let key = workspace
        .writing_font_key()
        .map_err(|err| err.to_string())?;
    let font = state
        .preview_font
        .get_or_build(&key, || workspace.compile_preview_font())
        .map_err(|err| err.to_string())?;
    let direction = if rtl { Direction::Rtl } else { Direction::Ltr };
    let runs = nueon_core::Workspace::shape_preview(&font.bytes, &lines, direction)
        .map_err(|err| err.to_string())?;
    Ok(PreviewShaping {
        key: font.key.clone(),
        glyph_ids: (*font.glyph_ids).clone(),
        runs,
    })
}

/// Check the writing system for problems a font export would hit, without
/// writing anything.
#[tauri::command]
pub fn writing_validate_font(state: State<'_, Shared>) -> Result<Vec<FontIssue>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace()?
        .validate_writing_font()
        .map_err(|err| err.to_string())
}

/// Compile the writing system to a TrueType font, verify it by reading it
/// back, and write it to a path chosen in a save dialog.
#[tauri::command]
pub fn writing_font_bytes(state: State<'_, Shared>) -> Result<Vec<u8>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let (bytes, _) = state
        .workspace()?
        .compile_writing_font()
        .map_err(|err| err.to_string())?;
    Ok(bytes)
}

/// Export the writing system as a TrueType font: the path is chosen in a
/// dialog run on the Rust side and the write is size- and extension-checked.
/// `writing_font_bytes` returns the same bytes for tests and the probes.
#[tauri::command]
pub async fn writing_export_font_dialog(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<FontExport, String> {
    let (bytes, report) = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state
            .workspace()?
            .compile_writing_font()
            .map_err(|err| err.to_string())?
    };
    let Some(path) =
        pick_save_file(&app, &[("TrueType font", &["ttf"])], Some("script.ttf")).await?
    else {
        return Err("cancelled".to_string());
    };
    write_bytes_checked(&path, &bytes, "ttf").map_err(|err| err.to_string())?;
    changed(&app, "writing");
    Ok(FontExport {
        glyphs: report.glyphs,
        mapped: report.mapped,
        bytes: report.bytes,
        source_glyphs: report.source_glyphs,
        lookups: report.lookups,
    })
}
