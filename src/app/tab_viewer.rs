//! The central dock tab viewer and the individual views.

use std::path::PathBuf;

use egui::{RichText, Ui};
use egui_dock::TabViewer;
use egui_extras::{Column, TableBuilder};
use uuid::Uuid;

use super::state::{
    DependencyPrompt, DependentInfo, DraftRename, GridView, PendingChange, Tab, TagRemovalRequest,
    UiState, WordRef,
};
use crate::model::{derivation, query, FieldType, FieldValue, TagDef, PARENT_TAG, WORDNAME_TAG};
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

#[derive(Clone)]
struct ColumnSpec {
    name: String,
    kind: ColumnKind,
}

#[derive(Clone, Copy)]
enum ColumnKind {
    Wordname,
    Parent,
    Tag(FieldType),
}

fn header_cell(
    ui: &mut Ui,
    spec: &ColumnSpec,
    view: &mut GridView,
    pending_removal: &mut Option<String>,
) {
    let name = spec.name.clone();
    let arrow = match view.query.sort.as_ref() {
        Some((column, query::SortDir::Asc)) if column == &name => " ▲",
        Some((column, query::SortDir::Desc)) if column == &name => " ▼",
        _ => "",
    };
    let search_active = view.search_open.as_deref() == Some(name.as_str());

    ui.vertical(|ui| {
        ui.horizontal(|ui| {
            let response = ui.add(
                egui::Label::new(RichText::new(format!("{name}{arrow}")).strong())
                    .sense(egui::Sense::click()),
            );
            if response.clicked() {
                toggle_sort(&mut view.query, &name);
            }
            response.context_menu(|ui| {
                if ui.button("Sort ascending").clicked() {
                    view.query.sort = Some((name.clone(), query::SortDir::Asc));
                    ui.close();
                }
                if ui.button("Sort descending").clicked() {
                    view.query.sort = Some((name.clone(), query::SortDir::Desc));
                    ui.close();
                }
                ui.separator();
                match spec.kind {
                    ColumnKind::Wordname => {}
                    ColumnKind::Parent => {
                        if ui.button("Has parent").clicked() {
                            set_presence(view, &name, Some(true));
                            ui.close();
                        }
                        if ui.button("No parent").clicked() {
                            set_presence(view, &name, Some(false));
                            ui.close();
                        }
                    }
                    ColumnKind::Tag(FieldType::Boolean) => {
                        if ui.button("True").clicked() {
                            set_boolean(view, &name, Some(true));
                            ui.close();
                        }
                        if ui.button("False").clicked() {
                            set_boolean(view, &name, Some(false));
                            ui.close();
                        }
                    }
                    ColumnKind::Tag(_) => {
                        if ui.button("Has value").clicked() {
                            set_presence(view, &name, Some(true));
                            ui.close();
                        }
                        if ui.button("No value").clicked() {
                            set_presence(view, &name, Some(false));
                            ui.close();
                        }
                    }
                }
                ui.separator();
                if ui.button("Clear filter").clicked() {
                    view.query.filters.remove(&name);
                    ui.close();
                }
                if !matches!(spec.kind, ColumnKind::Wordname) && ui.button("Hide column").clicked()
                {
                    view.hidden.insert(name.clone());
                    ui.close();
                }
                if matches!(spec.kind, ColumnKind::Tag(_)) && ui.button("Remove tag…").clicked() {
                    *pending_removal = Some(name.clone());
                    ui.close();
                }
            });

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui
                    .small_button(if search_active { "🔎" } else { "🔍" })
                    .on_hover_text("Search this column")
                    .clicked()
                {
                    view.search_open = if search_active {
                        None
                    } else {
                        Some(name.clone())
                    };
                    view.focus_search = !search_active;
                }
            });
        });

        if search_active {
            let entry = view.query.filters.entry(name.clone()).or_default();
            let response = ui.add(
                egui::TextEdit::singleline(&mut entry.text)
                    .hint_text("search")
                    .desired_width(f32::INFINITY),
            );
            if view.focus_search {
                response.request_focus();
                view.focus_search = false;
            }
        }
    });
}

fn toggle_sort(query: &mut query::TableQuery, column: &str) {
    query.sort = match &query.sort {
        Some((current, query::SortDir::Asc)) if current == column => {
            Some((column.to_string(), query::SortDir::Desc))
        }
        Some((current, query::SortDir::Desc)) if current == column => None,
        _ => Some((column.to_string(), query::SortDir::Asc)),
    };
}

fn set_presence(view: &mut GridView, column: &str, value: Option<bool>) {
    view.query
        .filters
        .entry(column.to_string())
        .or_default()
        .presence = value;
}

fn set_boolean(view: &mut GridView, column: &str, value: Option<bool>) {
    view.query
        .filters
        .entry(column.to_string())
        .or_default()
        .boolean = value;
}

fn wordname_cell(
    ui: &mut Ui,
    ws: &mut Workspace,
    state: &mut UiState,
    table: &str,
    id: Uuid,
    changed: &mut bool,
) {
    let key = (table.to_string(), id);
    let current = ws
        .dictionary
        .get_entry(table, id)
        .map(|entry| entry.wordname.clone())
        .unwrap_or_default();
    let mut text = state
        .rename_drafts
        .get(&key)
        .map(|draft| draft.text.clone())
        .unwrap_or_else(|| current.clone());

    let response = ui.add(egui::TextEdit::singleline(&mut text).desired_width(f32::INFINITY));

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
                if let Some(entry) = ws.dictionary.get_entry_mut(table, id) {
                    entry.wordname = text.clone();
                }
                *changed = true;
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
                        table: table.to_string(),
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
}

fn parent_cell(ui: &mut Ui, ws: &Workspace, state: &mut UiState, table: &str, id: Uuid) {
    let parents = ws
        .dictionary
        .get_entry(table, id)
        .map(|entry| entry.parents())
        .unwrap_or_default();
    if parents.is_empty() {
        ui.label(RichText::new("—").weak());
        return;
    }
    ui.horizontal_wrapped(|ui| {
        for parent in parents {
            match ws.dictionary.find_entry(parent) {
                Some((parent_table, entry)) => {
                    if ui.link(&entry.wordname).clicked() {
                        state.selected_word = Some(WordRef {
                            table: parent_table.to_string(),
                            id: parent,
                        });
                    }
                }
                None => {
                    ui.colored_label(ui.visuals().error_fg_color, "?");
                }
            }
        }
    });
}

fn dictionary(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState, table: String) {
    let Some(meta) = ws.dictionary.table(&table) else {
        ui.label(RichText::new("This table no longer exists.").weak());
        return;
    };

    let mut all_columns: Vec<ColumnSpec> = vec![
        ColumnSpec {
            name: WORDNAME_TAG.to_string(),
            kind: ColumnKind::Wordname,
        },
        ColumnSpec {
            name: PARENT_TAG.to_string(),
            kind: ColumnKind::Parent,
        },
    ];
    for tag in &meta.tags {
        if tag.name == WORDNAME_TAG || tag.name == PARENT_TAG {
            continue;
        }
        all_columns.push(ColumnSpec {
            name: tag.name.clone(),
            kind: ColumnKind::Tag(tag.kind),
        });
    }
    let total = meta.entries.len();

    let view = state.grid_views.get(&table).cloned().unwrap_or_default();
    let visible: Vec<ColumnSpec> = all_columns
        .iter()
        .filter(|spec| !view.hidden.contains(&spec.name))
        .cloned()
        .collect();
    let ids = query::ordered_ids(&ws.dictionary, meta, &view.query);

    ui.horizontal(|ui| {
        ui.heading(&table);
        ui.label(RichText::new(format!("showing {} of {total}", ids.len())).weak());
        if ui.button("Clear filters").clicked() {
            state.grid_views.entry(table.clone()).or_default().query = Default::default();
        }
        ui.menu_button("Columns", |ui| {
            let view = state.grid_views.entry(table.clone()).or_default();
            for spec in &all_columns {
                if matches!(spec.kind, ColumnKind::Wordname) {
                    ui.label(RichText::new(&spec.name).weak());
                    continue;
                }
                let mut shown = !view.hidden.contains(&spec.name);
                if ui.checkbox(&mut shown, &spec.name).changed() {
                    if shown {
                        view.hidden.remove(&spec.name);
                    } else {
                        view.hidden.insert(spec.name.clone());
                    }
                }
            }
        });
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

    let declared: Vec<String> = all_columns
        .iter()
        .filter(|spec| matches!(spec.kind, ColumnKind::Tag(_)))
        .map(|spec| spec.name.clone())
        .collect();
    if !declared.is_empty() {
        ui.horizontal_wrapped(|ui| {
            for name in &declared {
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
    let mut pending_removal: Option<String> = None;

    let search_open = state
        .grid_views
        .get(&table)
        .is_some_and(|view| view.search_open.is_some());
    let header_height = if search_open { 48.0 } else { 24.0 };

    TableBuilder::new(ui)
        .striped(true)
        .resizable(true)
        .id_salt(("dictionary", table.clone()))
        .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
        .columns(
            Column::initial(150.0).at_least(80.0).clip(true),
            visible.len(),
        )
        .column(Column::remainder())
        .header(header_height, |mut header| {
            let view = state.grid_views.entry(table.clone()).or_default();
            for spec in &visible {
                header.col(|ui| {
                    header_cell(ui, spec, view, &mut pending_removal);
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

                for spec in &visible {
                    match spec.kind {
                        ColumnKind::Wordname => {
                            row.col(|ui| {
                                wordname_cell(ui, ws, state, &table, id, &mut changed);
                            });
                        }
                        ColumnKind::Parent => {
                            row.col(|ui| {
                                parent_cell(ui, ws, state, &table, id);
                            });
                        }
                        ColumnKind::Tag(kind) => {
                            let name = spec.name.clone();
                            row.col(|ui| {
                                if let Some(entry) = ws.dictionary.get_entry_mut(&table, id) {
                                    match (kind, entry.values.get_mut(&name)) {
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
                    }
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

    if let Some(tag) = pending_removal {
        let affected = ws.preview_remove_tag(&table, &tag);
        state.pending_tag_removal = Some(TagRemovalRequest {
            table: table.clone(),
            tag,
            affected,
        });
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
