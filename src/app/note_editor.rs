//! The note editor: block live-preview with click-to-reveal.

use std::ops::Range;
use std::path::{Path, PathBuf};

use egui::{Key, RichText, TextEdit, Ui};

use crate::workspace::Workspace;

use super::markdown::{parse_regions, render_region};
use super::state::{NoteEdit, UiState};

/// Render a note, either as a live preview or as raw Markdown.
pub fn notes(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, path: PathBuf) {
    let Some(index) = ws.notes.iter().position(|note| note.path == path) else {
        ui.label(RichText::new("This note no longer exists.").weak());
        return;
    };

    if state
        .note_edit
        .as_ref()
        .is_some_and(|edit| edit.note != path)
    {
        state.note_edit = None;
    }

    ui.horizontal(|ui| {
        ui.heading(path.display().to_string());
        let toggle = if state.raw_mode { "Rendered" } else { "Raw" };
        if ui
            .button(toggle)
            .on_hover_text("Toggle raw Markdown (Ctrl+E)")
            .clicked()
        {
            state.raw_mode = !state.raw_mode;
            state.note_edit = None;
        }
        ui.label(RichText::new("autosaves").weak());
    });
    ui.separator();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            if state.raw_mode {
                raw_editor(ui, ws, state, index);
            } else {
                live_preview(ui, ws, state, path, index);
            }
        });
}

fn raw_editor(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, index: usize) {
    let changed = {
        let note = &mut ws.notes[index];
        ui.add_sized(
            ui.available_size(),
            TextEdit::multiline(&mut note.raw_content)
                .font(egui::TextStyle::Monospace)
                .code_editor()
                .desired_width(f32::INFINITY),
        )
        .changed()
    };
    if changed {
        let note = ws.notes[index].clone();
        if let Err(err) = ws.save_note(&note) {
            state.status = Some(format!("Save failed: {err}"));
        }
    }
}

fn live_preview(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, path: PathBuf, index: usize) {
    if state.note_edit.is_some() && ui.input(|input| input.key_pressed(Key::Escape)) {
        state.note_edit = None;
        return;
    }

    let mut source = ws.notes[index].raw_content.clone();

    let Some(edit) = state.note_edit.clone().filter(|edit| edit.note == path) else {
        if let Some(range) = render_source(ui, &source, 0) {
            activate(state, &path, &source, range);
        }
        return;
    };

    let start = edit.start.min(source.len());
    let end = edit.end.min(source.len()).max(start);

    let mut clicked = render_source(ui, &source[..start], 0);

    let mut buffer = edit.buffer.clone();
    let response = ui.add(
        TextEdit::multiline(&mut buffer)
            .desired_width(f32::INFINITY)
            .id(egui::Id::new(("langjar-note-edit", path.as_os_str()))),
    );
    if state.focus_edit {
        response.request_focus();
        state.focus_edit = false;
    }

    let mut active_end = end;
    if response.changed() {
        source = apply_region_edit(&source, start, end, &buffer);
        active_end = start + buffer.len();
        ws.notes[index].raw_content = source.clone();
        if let Some(session) = state.note_edit.as_mut() {
            session.buffer = buffer;
            session.start = start;
            session.end = active_end;
        }
        let note = ws.notes[index].clone();
        if let Err(err) = ws.save_note(&note) {
            state.status = Some(format!("Save failed: {err}"));
        }
    }

    let tail = active_end.min(source.len());
    if let Some(range) = render_source(ui, &source[tail..], tail) {
        clicked = Some(range);
    }

    if let Some(range) = clicked {
        activate(state, &path, &source, range);
    } else if response.lost_focus() {
        state.note_edit = None;
    }
}

fn activate(state: &mut UiState, note: &Path, source: &str, range: Range<usize>) {
    let buffer = source.get(range.clone()).unwrap_or_default().to_string();
    state.note_edit = Some(NoteEdit {
        note: note.to_path_buf(),
        start: range.start,
        end: range.end,
        buffer,
    });
    state.focus_edit = true;
}

fn render_source(ui: &mut Ui, text: &str, offset: usize) -> Option<Range<usize>> {
    let mut clicked = None;
    for region in parse_regions(text) {
        if render_region(ui, text, &region) {
            clicked = Some((region.content.start + offset)..(region.content.end + offset));
        }
    }
    clicked
}

/// Replace `source[start..end]` with `buffer`, clamping the range to the source.
fn apply_region_edit(source: &str, start: usize, end: usize, buffer: &str) -> String {
    let start = start.min(source.len());
    let end = end.min(source.len()).max(start);
    format!("{}{}{}", &source[..start], buffer, &source[end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applying_an_edit_replaces_only_the_region() {
        let source = "one\ntwo\nthree";
        assert_eq!(apply_region_edit(source, 4, 7, "TWO"), "one\nTWO\nthree");
        assert_eq!(apply_region_edit(source, 4, 7, "a\nb"), "one\na\nb\nthree");
        assert_eq!(apply_region_edit(source, 4, 7, ""), "one\n\nthree");
    }

    #[test]
    fn applying_an_edit_clamps_out_of_range() {
        let source = "abc";
        assert_eq!(apply_region_edit(source, 1, 99, "X"), "aX");
        assert_eq!(apply_region_edit(source, 99, 99, "X"), "abcX");
    }
}
