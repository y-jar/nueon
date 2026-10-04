//! The central dock tab viewer and the individual views.

use std::path::PathBuf;

use egui::{RichText, Ui};
use egui_dock::TabViewer;
use egui_extras::{Column, TableBuilder};
use uuid::Uuid;

use super::state::{
    DependencyPrompt, DependentInfo, DraftRename, PendingChange, Tab, TagRemovalRequest, UiState,
    WordRef,
};
use crate::model::{derivation, FieldType, FieldValue, TagDef, WORDNAME_TAG};
use crate::vcs::GitStatus;
use crate::workspace::Workspace;

/// Renders each dock tab by delegating to the appropriate view.
pub struct AppTabViewer<'a> {
    pub workspace: &'a mut Workspace,
    pub state: &'a mut UiState,
}

impl TabViewer for AppTabViewer<'_> {
    type Tab = Tab;

    fn id(&mut self, tab: &mut Tab) -> egui::Id {
        egui::Id::new(tab)
    }

    fn title(&mut self, tab: &mut Tab) -> egui::WidgetText {
        tab.title().into()
    }

    fn ui(&mut self, ui: &mut Ui, tab: &mut Tab) {
        match tab.clone() {
            Tab::Welcome => welcome(ui, self.workspace, self.state),
            Tab::Notes(path) => notes(ui, self.workspace, self.state, path),
            Tab::Dictionary(table) => dictionary(ui, self.workspace, self.state, table),
            Tab::Translation => translation(ui, self.workspace),
        }
    }
}

fn welcome(ui: &mut Ui, ws: &Workspace, state: &mut UiState) {
    ui.add_space(8.0);
    ui.heading("langjar");
    ui.label("A conlang editor and creation app.");
    ui.add_space(12.0);

    egui::Grid::new("welcome_stats")
        .num_columns(2)
        .spacing([16.0, 4.0])
        .show(ui, |ui| {
            ui.strong("Tables");
            ui.label(ws.dictionary.tables.len().to_string());
            ui.end_row();
            ui.strong("Words");
            ui.label(ws.dictionary.all_entries().count().to_string());
            ui.end_row();
            ui.strong("Notes");
            ui.label(ws.notes.len().to_string());
            ui.end_row();
            ui.strong("Git");
            ui.label(match &ws.vcs {
                GitStatus::Ready(_) => "ready",
                GitStatus::NotARepo => "not a repository",
                GitStatus::GitNotInstalled => "not installed",
            });
            ui.end_row();
        });

    ui.add_space(12.0);
    ui.label(RichText::new("Tables").strong());
    if ws.dictionary.tables.is_empty() {
        ui.label(RichText::new("Create a table from the left sidebar.").weak());
    }
    for table in ws.dictionary.tables() {
        if ui.link(format!("Open table: {}", table.name)).clicked() {
            state.request_tab(Tab::Dictionary(table.name.clone()));
        }
    }
}

fn notes(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, path: PathBuf) {
    super::note_editor::notes(ui, ws, state, path);
}

fn dictionary(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, table: String) {
    let Some(meta) = ws.dictionary.table(&table) else {
        ui.label(RichText::new("This table no longer exists.").weak());
        return;
    };

    let columns: Vec<(String, FieldType)> = meta
        .tags
        .iter()
        .filter(|t| t.name != WORDNAME_TAG)
        .map(|t| (t.name.clone(), t.kind))
        .collect();
    let ids: Vec<Uuid> = meta.entries.iter().map(|e| e.id).collect();

    ui.horizontal(|ui| {
        ui.heading(&table);
        ui.label(RichText::new(format!("{} words", ids.len())).weak());
    });

    ui.horizontal(|ui| {
        ui.add(
            egui::TextEdit::singleline(&mut state.new_wordname)
                .hint_text("new word")
                .desired_width(160.0),
        );
        if ui.button("＋ Word").clicked() {
            let name = state.new_wordname.trim().to_string();
            if !name.is_empty() {
                match ws.create_entry(&table, name) {
                    Ok(Some(_)) => state.new_wordname.clear(),
                    Ok(None) => {}
                    Err(err) => state.status = Some(format!("Add word failed: {err}")),
                }
            }
        }

        ui.separator();
        ui.add(
            egui::TextEdit::singleline(&mut state.new_tag_name)
                .hint_text("new tag")
                .desired_width(120.0),
        );
        egui::ComboBox::from_id_salt("new_tag_kind")
            .selected_text(format!("{:?}", state.new_tag_kind))
            .show_ui(ui, |ui| {
                ui.selectable_value(&mut state.new_tag_kind, FieldType::Text, "Text");
                ui.selectable_value(&mut state.new_tag_kind, FieldType::Boolean, "Boolean");
                ui.selectable_value(&mut state.new_tag_kind, FieldType::TagList, "Tag List");
                ui.selectable_value(&mut state.new_tag_kind, FieldType::Reference, "Reference");
            });
        if ui.button("＋ Tag").clicked() {
            let name = state.new_tag_name.trim().to_string();
            if !name.is_empty() {
                match ws.add_tag(&table, TagDef::new(name, state.new_tag_kind)) {
                    Ok(_) => state.new_tag_name.clear(),
                    Err(err) => state.status = Some(format!("Add tag failed: {err}")),
                }
            }
        }
    });

    if !columns.is_empty() {
        ui.horizontal_wrapped(|ui| {
            for (name, _) in &columns {
                ui.label(RichText::new(name).monospace());
                if ui.small_button("✕").on_hover_text("Remove tag").clicked() {
                    let affected = ws.preview_remove_tag(&table, name);
                    state.pending_tag_removal = Some(TagRemovalRequest {
                        table: table.clone(),
                        tag: name.clone(),
                        affected,
                    });
                }
            }
        });
    }

    ui.separator();

    let mut changed = false;
    let mut to_delete: Option<Uuid> = None;

    TableBuilder::new(ui)
        .striped(true)
        .resizable(true)
        .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
        .column(Column::initial(140.0).at_least(80.0).clip(true))
        .columns(
            Column::initial(150.0).at_least(80.0).clip(true),
            columns.len(),
        )
        .column(Column::remainder())
        .header(22.0, |mut header| {
            header.col(|ui| {
                ui.strong(WORDNAME_TAG);
            });
            for (name, _) in &columns {
                header.col(|ui| {
                    ui.strong(name);
                });
            }
            header.col(|ui| {
                ui.strong("");
            });
        })
        .body(|body| {
            body.rows(24.0, ids.len(), |mut row| {
                let id = ids[row.index()];
                let selected = state
                    .selected_word
                    .as_ref()
                    .is_some_and(|w| w.id == id && w.table == table);

                row.col(|ui| {
                    let key = (table.clone(), id);
                    let current = ws
                        .dictionary
                        .get_entry(&table, id)
                        .map(|entry| entry.wordname.clone())
                        .unwrap_or_default();
                    let mut text = state
                        .rename_drafts
                        .get(&key)
                        .map(|draft| draft.text.clone())
                        .unwrap_or_else(|| current.clone());

                    let response =
                        ui.add(egui::TextEdit::singleline(&mut text).desired_width(f32::INFINITY));

                    if response.gained_focus() {
                        state.rename_drafts.insert(
                            key.clone(),
                            DraftRename {
                                base: current.clone(),
                                text: current,
                            },
                        );
                    }
                    if response.changed() {
                        let base = state
                            .rename_drafts
                            .get(&key)
                            .map(|draft| draft.base.clone())
                            .unwrap_or_else(|| text.clone());
                        state.rename_drafts.insert(
                            key.clone(),
                            DraftRename {
                                base: base.clone(),
                                text: text.clone(),
                            },
                        );
                        if text != base {
                            if ws.dictionary.dependent_count(id) == 0 {
                                if let Some(entry) = ws.dictionary.get_entry_mut(&table, id) {
                                    entry.wordname = text.clone();
                                }
                                changed = true;
                            } else if state
                                .dependency_prompt
                                .as_ref()
                                .is_none_or(|prompt| prompt.change.id() != id)
                            {
                                let dependents = derivation::descendants(&ws.dictionary, id)
                                    .into_iter()
                                    .map(|dep| DependentInfo {
                                        table: dep.table,
                                        id: dep.id,
                                        wordname: dep.wordname,
                                    })
                                    .collect();
                                state.dependency_prompt = Some(DependencyPrompt {
                                    change: PendingChange::Rename {
                                        table: table.clone(),
                                        id,
                                        old: base,
                                        new: text,
                                    },
                                    dependents,
                                });
                            }
                        }
                    }
                    if response.lost_focus()
                        && state
                            .dependency_prompt
                            .as_ref()
                            .is_none_or(|prompt| prompt.change.id() != id)
                    {
                        state.rename_drafts.remove(&key);
                    }
                });

                for (name, kind) in &columns {
                    row.col(|ui| {
                        if let Some(entry) = ws.dictionary.get_entry_mut(&table, id) {
                            match (kind, entry.values.get_mut(name)) {
                                (FieldType::Text, Some(FieldValue::Text(text))) => {
                                    if ui.add(egui::TextEdit::singleline(text)).changed() {
                                        changed = true;
                                    }
                                }
                                (FieldType::Boolean, Some(FieldValue::Boolean(flag))) => {
                                    if ui.checkbox(flag, "").changed() {
                                        changed = true;
                                    }
                                }
                                (_, Some(value)) => {
                                    ui.label(display_value(value));
                                }
                                (_, None) => {
                                    ui.label(RichText::new("—").weak());
                                }
                            }
                        }
                    });
                }

                row.col(|ui| {
                    if ui.selectable_label(selected, "inspect").clicked() {
                        state.selected_word = Some(WordRef {
                            table: table.clone(),
                            id,
                        });
                    }
                    if ui.small_button("✕").on_hover_text("Delete word").clicked() {
                        to_delete = Some(id);
                    }
                });
            });
        });

    if changed {
        if let Err(err) = ws.save_table_edits(&table) {
            state.status = Some(format!("Save failed: {err}"));
        }
    }

    if let Some(id) = to_delete {
        let children = derivation::direct_children(&ws.dictionary, id);
        if children.is_empty() {
            match ws.delete_entry(&table, id) {
                Ok(Some(_)) => state.selected_word = None,
                Ok(None) => {}
                Err(err) => state.status = Some(format!("Delete failed: {err}")),
            }
        } else {
            let name = ws
                .dictionary
                .get_entry(&table, id)
                .map(|entry| entry.wordname.clone())
                .unwrap_or_default();
            let dependents = children
                .into_iter()
                .map(|child| DependentInfo {
                    table: child.table,
                    id: child.id,
                    wordname: child.wordname,
                })
                .collect();
            state.dependency_prompt = Some(DependencyPrompt {
                change: PendingChange::Delete { table, id, name },
                dependents,
            });
        }
    }
}

fn translation(ui: &mut Ui, ws: &Workspace) {
    ui.heading("Translation");
    ui.label(RichText::new("The drag-and-drop syntax builder arrives in a later stage.").weak());
    ui.separator();
    ui.label(RichText::new("Saved syntax grids").strong());
    if ws.translation.grids.is_empty() {
        ui.label(RichText::new("No presets yet.").weak());
    }
    for grid in &ws.translation.grids {
        ui.label(format!(
            "{} · {} slot(s)",
            grid.preset_name,
            grid.slots.len()
        ));
    }
    if let Some(default) = &ws.translation.default_rule {
        ui.label(RichText::new(format!("default rule: {default}")).weak());
    }
}

fn display_value(value: &FieldValue) -> String {
    match value {
        FieldValue::Text(text) => text.clone(),
        FieldValue::Boolean(flag) => flag.to_string(),
        FieldValue::TagList(list) => list.join(", "),
        FieldValue::Reference(id) => format!("→ {id}"),
        FieldValue::References(ids) => ids
            .iter()
            .map(|id| format!("→ {id}"))
            .collect::<Vec<_>>()
            .join(", "),
    }
}
