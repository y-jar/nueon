//! Drag-and-drop translation syntax-grid builder.

use egui::{Frame, Id, RichText, Ui};

use crate::translation::{ClauseSlot, SyntaxGrid};
use crate::workspace::Workspace;

use super::state::{BuilderPayload, UiState};

enum CanvasAction {
    Remove(usize),
    MoveUp(usize),
    MoveDown(usize),
}

/// The translation tab: preset management plus the drag-and-drop builder.
pub fn translation(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState) {
    let tags: Vec<String> = ws.dictionary.known_tag_names().into_iter().collect();

    preset_bar(ui, ws, state);
    ui.separator();

    ui.horizontal_top(|ui| {
        ui.vertical(|ui| {
            ui.set_min_width(200.0);
            palette(ui, state, &tags);
        });
        ui.separator();
        ui.vertical(|ui| {
            canvas(ui, state, &tags);
        });
    });

    super::translation_run::run(ui, ws, state);
}

fn preset_bar(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState) {
    ui.horizontal(|ui| {
        ui.label("Preset:");
        let selected = state.translation.draft.preset_name.clone();
        egui::ComboBox::from_id_salt("translation_preset")
            .selected_text(selected.clone())
            .show_ui(ui, |ui| {
                for grid in &ws.translation.grids {
                    let loaded =
                        state.translation.loaded.as_deref() == Some(grid.preset_name.as_str());
                    if ui.selectable_label(loaded, &grid.preset_name).clicked() {
                        state.translation.draft = grid.clone();
                        state.translation.loaded = Some(grid.preset_name.clone());
                    }
                }
            });
        ui.add(
            egui::TextEdit::singleline(&mut state.translation.draft.preset_name)
                .hint_text("name")
                .desired_width(150.0),
        );
        if ui.button("New").clicked() {
            state.translation.draft = SyntaxGrid::new("New preset");
            state.translation.loaded = None;
        }
        if ui.button("Save").clicked() {
            save_preset(ws, state);
        }
        if ui.button("Delete").clicked() {
            delete_preset(ws, state);
        }
    });
}

fn palette(ui: &mut Ui, state: &mut UiState, tags: &[String]) {
    ui.label(RichText::new("Tags").strong());
    if tags.is_empty() {
        ui.label(RichText::new("No tags yet.").weak());
    }
    egui::ScrollArea::vertical()
        .id_salt("palette_tags")
        .max_height(240.0)
        .show(ui, |ui| {
            for name in tags {
                ui.dnd_drag_source(
                    Id::new(("palette_tag", name)),
                    BuilderPayload::Tag(name.clone()),
                    |ui| {
                        ui.label(RichText::new(format!("#{name}")).monospace());
                    },
                );
            }
        });

    ui.separator();
    ui.label(RichText::new("Add").strong());
    ui.add(
        egui::TextEdit::singleline(&mut state.translation.new_literal)
            .hint_text("literal text")
            .desired_width(160.0),
    );
    for (label, payload) in [
        ("\"literal\"", BuilderPayload::Literal),
        ("* wildcard", BuilderPayload::Wildcard),
        ("␣ spacer", BuilderPayload::Spacer),
    ] {
        ui.dnd_drag_source(Id::new(("palette_add", label)), payload, |ui| {
            ui.label(label);
        });
    }

    ui.separator();
    ui.horizontal_wrapped(|ui| {
        if ui.small_button("＋ literal").clicked() {
            let text = state.translation.new_literal.clone();
            state
                .translation
                .draft
                .insert_slot(usize::MAX, ClauseSlot::Literal { text });
        }
        if ui.small_button("＋ wildcard").clicked() {
            state
                .translation
                .draft
                .insert_slot(usize::MAX, ClauseSlot::Wildcard);
        }
        if ui.small_button("＋ spacer").clicked() {
            state
                .translation
                .draft
                .insert_slot(usize::MAX, ClauseSlot::Spacer);
        }
    });
}

fn canvas(ui: &mut Ui, state: &mut UiState, tags: &[String]) {
    ui.label(RichText::new("Clause structure").strong());
    ui.label(RichText::new("Drag tags from the left into the gaps below.").weak());

    let len = state.translation.draft.slots.len();
    let mut drop: Option<(usize, BuilderPayload)> = None;
    let mut action: Option<CanvasAction> = None;

    for index in 0..=len {
        let (_, dropped) =
            ui.dnd_drop_zone::<BuilderPayload, _>(Frame::NONE.inner_margin(4.0), |ui| {
                if len == 0 {
                    ui.label(RichText::new("drop tags here").weak());
                } else {
                    ui.allocate_space(egui::vec2(ui.available_width(), 3.0));
                }
            });
        if let Some(payload) = dropped {
            drop = Some((index, (*payload).clone()));
        }

        if index == len {
            break;
        }
        slot_card(ui, state, index, tags, &mut action);
    }

    if let Some((index, payload)) = drop {
        let literal = state.translation.new_literal.clone();
        apply_drop(&mut state.translation.draft, index, payload, &literal);
    }
    if let Some(action) = action {
        match action {
            CanvasAction::Remove(index) => {
                state.translation.draft.remove_slot(index);
            }
            CanvasAction::MoveUp(index) => {
                if index > 0 {
                    state.translation.draft.move_slot(index, index - 1);
                }
            }
            CanvasAction::MoveDown(index) => {
                state.translation.draft.move_slot(index, index + 2);
            }
        }
    }

    ui.separator();
    let preview: Vec<String> = state
        .translation
        .draft
        .slots
        .iter()
        .map(ClauseSlot::label)
        .collect();
    ui.label(RichText::new(format!("sequence: {}", preview.join("  "))).monospace());
}

fn slot_card(
    ui: &mut Ui,
    state: &mut UiState,
    index: usize,
    tags: &[String],
    action: &mut Option<CanvasAction>,
) {
    let Some(slot) = state.translation.draft.slots.get(index).cloned() else {
        return;
    };

    Frame::group(ui.style()).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.dnd_drag_source(
                Id::new(("slot_grip", index)),
                BuilderPayload::Move(index),
                |ui| {
                    ui.label(RichText::new("⠿").weak());
                },
            );

            match slot {
                ClauseSlot::RequiredTag { tag } => {
                    ui.label(RichText::new("#").monospace());
                    let mut current = tag.clone();
                    egui::ComboBox::from_id_salt(("slot_tag", index))
                        .selected_text(current.clone())
                        .show_ui(ui, |ui| {
                            for name in tags {
                                ui.selectable_value(&mut current, name.clone(), name);
                            }
                        });
                    if current != tag {
                        if let Some(slot) = state.translation.draft.slots.get_mut(index) {
                            *slot = ClauseSlot::RequiredTag { tag: current };
                        }
                    }
                }
                ClauseSlot::Literal { text } => {
                    let mut value = text.clone();
                    if ui
                        .add(egui::TextEdit::singleline(&mut value).desired_width(140.0))
                        .changed()
                    {
                        if let Some(slot) = state.translation.draft.slots.get_mut(index) {
                            *slot = ClauseSlot::Literal { text: value };
                        }
                    }
                }
                ClauseSlot::Wildcard => {
                    ui.label(RichText::new("* wildcard").italics());
                }
                ClauseSlot::Spacer => {
                    ui.label(RichText::new("␣ spacer").italics());
                }
            }

            if ui.small_button("↑").on_hover_text("Move up").clicked() {
                *action = Some(CanvasAction::MoveUp(index));
            }
            if ui.small_button("↓").on_hover_text("Move down").clicked() {
                *action = Some(CanvasAction::MoveDown(index));
            }
            if ui.small_button("✕").on_hover_text("Remove").clicked() {
                *action = Some(CanvasAction::Remove(index));
            }
        });
    });
}

fn apply_drop(draft: &mut SyntaxGrid, index: usize, payload: BuilderPayload, literal: &str) {
    match payload {
        BuilderPayload::Tag(tag) => draft.insert_slot(index, ClauseSlot::RequiredTag { tag }),
        BuilderPayload::Literal => draft.insert_slot(
            index,
            ClauseSlot::Literal {
                text: literal.to_string(),
            },
        ),
        BuilderPayload::Wildcard => draft.insert_slot(index, ClauseSlot::Wildcard),
        BuilderPayload::Spacer => draft.insert_slot(index, ClauseSlot::Spacer),
        BuilderPayload::Move(from) => draft.move_slot(from, index),
    }
}

fn save_preset(ws: &mut Workspace, state: &mut UiState) {
    let draft = state.translation.draft.clone();
    if draft.preset_name.trim().is_empty() {
        state.status = Some("Preset needs a name".to_string());
        return;
    }
    if let Some(existing) = ws
        .translation
        .grids
        .iter_mut()
        .find(|grid| grid.preset_name == draft.preset_name)
    {
        *existing = draft.clone();
    } else {
        ws.translation.grids.push(draft.clone());
    }
    state.translation.loaded = Some(draft.preset_name.clone());
    match ws.save_translation() {
        Ok(()) => state.status = Some(format!("Saved preset \"{}\"", draft.preset_name)),
        Err(err) => state.status = Some(format!("Save failed: {err}")),
    }
}

fn delete_preset(ws: &mut Workspace, state: &mut UiState) {
    let Some(name) = state.translation.loaded.clone() else {
        state.status = Some("Load a preset before deleting".to_string());
        return;
    };
    ws.translation.grids.retain(|grid| grid.preset_name != name);
    state.translation.loaded = None;
    match ws.save_translation() {
        Ok(()) => state.status = Some(format!("Deleted preset \"{name}\"")),
        Err(err) => state.status = Some(format!("Delete failed: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_drop_inserts_and_moves() {
        let mut draft = SyntaxGrid::new("t");
        apply_drop(&mut draft, 0, BuilderPayload::Tag("Verb".into()), "");
        apply_drop(&mut draft, 0, BuilderPayload::Tag("Subject".into()), "");
        assert_eq!(
            draft.slots,
            vec![
                ClauseSlot::RequiredTag {
                    tag: "Subject".into()
                },
                ClauseSlot::RequiredTag { tag: "Verb".into() },
            ]
        );

        apply_drop(&mut draft, 4, BuilderPayload::Move(0), "");
        assert_eq!(
            draft.slots,
            vec![
                ClauseSlot::RequiredTag { tag: "Verb".into() },
                ClauseSlot::RequiredTag {
                    tag: "Subject".into()
                },
            ]
        );
    }

    #[test]
    fn apply_drop_uses_literal_text() {
        let mut draft = SyntaxGrid::new("t");
        apply_drop(&mut draft, 0, BuilderPayload::Literal, "ka");
        assert_eq!(draft.slots, vec![ClauseSlot::Literal { text: "ka".into() }]);
    }
}
