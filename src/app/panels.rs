//! Top command bar, left sidebar, inspector, git panel, and dialogs.

use egui::{RichText, Ui};

use super::state::{
    parse_command, CommandFilter, DependencyPrompt, GitAction, ManualConvert, ManualRow,
    ParentPicker, PendingChange, Tab, UiState, WordRef,
};
use crate::model::{derivation, FieldValue, PARENT_TAG};
use crate::vcs::GitStatus;
use crate::workspace::Workspace;
use uuid::Uuid;

const ERROR: egui::Color32 = egui::Color32::from_rgb(214, 120, 90);
const CHANGED: egui::Color32 = egui::Color32::from_rgb(206, 176, 110);

/// The global command & search bar.
pub fn command_bar(ui: &mut Ui, ws: &Workspace, state: &mut UiState) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("langloom").strong().size(16.0));
        let response = ui.add(
            egui::TextEdit::singleline(&mut state.command_query)
                .hint_text("Search…   tag:  def:")
                .desired_width(320.0),
        );
        if state.focus_command {
            response.request_focus();
            state.focus_command = false;
        }

        ui.separator();
        let label = if state.git_panel_open {
            "Source Control ●"
        } else {
            "Source Control"
        };
        if ui.button(label).clicked() {
            state.git_panel_open = !state.git_panel_open;
        }

        if let Some(status) = state.status.clone() {
            ui.separator();
            ui.label(RichText::new(status).weak());
            if ui.small_button("✕").clicked() {
                state.status = None;
            }
        }
    });

    if let Some(filter) = parse_command(&state.command_query) {
        let results = search(ws, &filter);
        if results.is_empty() {
            ui.label(RichText::new("No matches.").weak());
        } else {
            ui.horizontal_wrapped(|ui| {
                for (table, id, wordname) in results {
                    if ui.link(format!("{wordname} · {table}")).clicked() {
                        state.selected_word = Some(WordRef {
                            table: table.clone(),
                            id,
                        });
                        state.request_tab(Tab::Dictionary(table));
                    }
                }
            });
        }
    }
}

fn search(ws: &Workspace, filter: &CommandFilter) -> Vec<(String, uuid::Uuid, String)> {
    let mut out: Vec<(String, uuid::Uuid, String)> = Vec::new();
    match filter {
        CommandFilter::Global(query) => {
            for entry in ws.dictionary.search(query) {
                if let Some((table, _)) = ws.dictionary.find_entry(entry.id) {
                    out.push((table.to_string(), entry.id, entry.wordname.clone()));
                }
            }
        }
        CommandFilter::Tag(tag) => {
            for table in ws.dictionary.tables() {
                for entry in ws.dictionary.entries_with_tag(&table.name, tag) {
                    out.push((table.name.clone(), entry.id, entry.wordname.clone()));
                }
            }
        }
        CommandFilter::Definition(query) => {
            let needle = query.to_lowercase();
            for table in ws.dictionary.tables() {
                for entry in &table.entries {
                    let hit = entry.definition().is_some_and(|senses| {
                        senses.iter().any(|s| s.to_lowercase().contains(&needle))
                    });
                    if hit {
                        out.push((table.name.clone(), entry.id, entry.wordname.clone()));
                    }
                }
            }
        }
    }
    out.truncate(12);
    out
}

/// The left navigation sidebar.
pub fn sidebar(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState) {
    ui.heading("Notes");
    if ws.notes.is_empty() {
        ui.label(RichText::new("No notes yet.").weak());
    }
    for note in &ws.notes {
        let path = note.path.clone();
        let selected = state.selected_note.as_ref() == Some(&path);
        if ui
            .selectable_label(selected, path.display().to_string())
            .clicked()
        {
            state.selected_note = Some(path.clone());
            state.request_tab(Tab::Notes(path));
        }
    }

    ui.separator();
    ui.heading("Tables");
    let tables: Vec<(String, usize)> = ws
        .dictionary
        .tables()
        .map(|t| (t.name.clone(), t.entries.len()))
        .collect();
    if tables.is_empty() {
        ui.label(RichText::new("No tables yet.").weak());
    }
    for (name, count) in tables {
        if ui
            .selectable_label(false, format!("{name}  ({count})"))
            .clicked()
        {
            state.request_tab(Tab::Dictionary(name));
        }
    }
    ui.horizontal(|ui| {
        ui.add(
            egui::TextEdit::singleline(&mut state.new_table_name)
                .hint_text("new table")
                .desired_width(110.0),
        );
        if ui.button("＋").clicked() {
            let name = state.new_table_name.trim().to_string();
            if !name.is_empty() {
                match ws.create_table(&name) {
                    Ok(_) => {
                        state.new_table_name.clear();
                        state.request_tab(Tab::Dictionary(name));
                    }
                    Err(err) => state.status = Some(format!("Create table failed: {err}")),
                }
            }
        }
    });

    ui.separator();
    ui.heading("Presets");
    let presets: Vec<String> = ws
        .translation
        .grids
        .iter()
        .map(|g| g.preset_name.clone())
        .collect();
    if presets.is_empty() {
        ui.label(RichText::new("No presets yet.").weak());
    }
    for name in presets {
        if ui.selectable_label(false, name).clicked() {
            state.request_tab(Tab::Translation);
        }
    }
}

/// The right context inspector.
pub fn inspector(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState) {
    ui.heading("Inspector");

    let Some(word) = state.selected_word.clone() else {
        if let Some(note) = &state.selected_note {
            ui.label(format!("note: {}", note.display()));
        } else {
            ui.label(RichText::new("Select a word or note.").weak());
        }
        return;
    };

    let Some(entry) = ws.dictionary.get_entry(&word.table, word.id) else {
        state.selected_word = None;
        ui.label(RichText::new("Selection no longer exists.").weak());
        return;
    };

    let wordname = entry.wordname.clone();
    let values: Vec<(String, String)> = entry
        .values
        .iter()
        .filter(|(name, _)| name.as_str() != PARENT_TAG)
        .map(|(name, value)| (name.clone(), display_value(value)))
        .collect();
    let parents = entry.parents();
    let ancestors: Vec<(String, Uuid, String)> = ws
        .dictionary
        .ancestors_of(word.id)
        .into_iter()
        .filter_map(|a| {
            ws.dictionary
                .find_entry(a.id)
                .map(|(table, e)| (table.to_string(), e.id, e.wordname.clone()))
        })
        .collect();
    let children: Vec<(String, Uuid, String)> = ws
        .dictionary
        .children_of(word.id)
        .into_iter()
        .filter_map(|c| {
            ws.dictionary
                .find_entry(c.id)
                .map(|(table, e)| (table.to_string(), e.id, e.wordname.clone()))
        })
        .collect();

    ui.label(RichText::new(&wordname).strong().size(18.0));
    ui.label(RichText::new(format!("table: {}", word.table)).weak());
    ui.separator();

    if values.is_empty() {
        ui.label(RichText::new("No tags applied.").weak());
    }
    for (name, value) in &values {
        ui.horizontal(|ui| {
            ui.strong(name);
            ui.label(value);
        });
    }

    ui.separator();
    ui.label(RichText::new("Etymology").strong());
    if ui.button("＋ Add parent").clicked() {
        state.parent_picker = Some(ParentPicker {
            table: word.table.clone(),
            child: word.id,
            filter: String::new(),
        });
    }

    if parents.is_empty() {
        ui.label(RichText::new("No parents (root word).").weak());
    }
    let mut removals: Vec<Uuid> = Vec::new();
    for parent in &parents {
        ui.horizontal(|ui| {
            if let Some((ptable, pentry)) = ws.dictionary.find_entry(*parent) {
                if ui.link(&pentry.wordname).clicked() {
                    state.selected_word = Some(WordRef {
                        table: ptable.to_string(),
                        id: *parent,
                    });
                }
                ui.label(RichText::new(ptable).weak());
            } else {
                ui.colored_label(ERROR, "(missing)");
            }
            if ui
                .small_button("✕")
                .on_hover_text("Remove parent")
                .clicked()
            {
                removals.push(*parent);
            }
        });
    }
    if let Some(parent) = removals.first() {
        state.remove_parent = Some((word.table.clone(), word.id, *parent));
    }

    if !ancestors.is_empty() {
        egui::CollapsingHeader::new(format!("Ancestors ({})", ancestors.len())).show(ui, |ui| {
            for (table, id, name) in &ancestors {
                if ui.link(name).clicked() {
                    state.selected_word = Some(WordRef {
                        table: table.clone(),
                        id: *id,
                    });
                }
            }
        });
    }

    egui::CollapsingHeader::new(format!("Direct derivatives ({})", children.len()))
        .default_open(true)
        .show(ui, |ui| {
            if children.is_empty() {
                ui.label(RichText::new("None.").weak());
            }
            for (table, id, name) in &children {
                ui.horizontal(|ui| {
                    if ui.link(name).clicked() {
                        state.selected_word = Some(WordRef {
                            table: table.clone(),
                            id: *id,
                        });
                    }
                    ui.label(RichText::new(table).weak());
                });
            }
        });
}

/// The source-control side panel.
pub fn git_panel(ui: &mut Ui, ws: &Workspace, state: &mut UiState) {
    ui.heading("Source Control");
    match &ws.vcs {
        GitStatus::GitNotInstalled => {
            ui.colored_label(ERROR, "git is not installed.");
            ui.label("Install git to enable history and check-ins.");
        }
        GitStatus::NotARepo => {
            ui.label("This workspace is not a git repository yet.");
            if ui.button("Initialize repository").clicked() {
                state.git_action = Some(GitAction::Init);
            }
        }
        GitStatus::Ready(_) => {
            let repo = ws.git().expect("ready repo");

            let mut auto = ws.settings.auto_checkin;
            if ui.checkbox(&mut auto, "Auto check-in").changed() {
                state.set_auto_checkin = Some((auto, ws.settings.auto_checkin_secs));
            }
            ui.separator();

            match repo.status() {
                Ok(entries) if entries.is_empty() => {
                    ui.label(RichText::new("Working tree clean.").weak());
                }
                Ok(entries) => {
                    ui.colored_label(CHANGED, format!("{} changed file(s):", entries.len()));
                    egui::ScrollArea::vertical()
                        .max_height(140.0)
                        .show(ui, |ui| {
                            for entry in &entries {
                                ui.label(format!("{}  {}", entry.code, entry.path.display()));
                            }
                        });
                }
                Err(err) => {
                    ui.colored_label(ERROR, format!("status error: {err}"));
                }
            }

            ui.separator();
            ui.add(
                egui::TextEdit::singleline(&mut state.commit_message)
                    .hint_text("Commit message")
                    .desired_width(f32::INFINITY),
            );
            ui.horizontal(|ui| {
                if ui.button("Check in").clicked() {
                    state.git_action = Some(GitAction::Checkin(state.commit_message.clone()));
                }
                if ui.button("Clear").clicked() {
                    state.commit_message.clear();
                }
            });

            ui.separator();
            ui.label(RichText::new("History").strong());
            match repo.log(15) {
                Ok(commits) => {
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        for commit in commits {
                            ui.horizontal(|ui| {
                                ui.monospace(short(&commit.id));
                                ui.label(commit.summary);
                            });
                        }
                    });
                }
                Err(err) => {
                    ui.label(RichText::new(format!("no history: {err}")).weak());
                }
            }
        }
    }
}

/// Modal dialogs: the git prompt and the tag-removal confirmation.
pub fn dialogs(ctx: &egui::Context, ws: &mut Workspace, state: &mut UiState) {
    if !state.git_prompt_dismissed {
        match &ws.vcs {
            GitStatus::NotARepo => {
                egui::Window::new("Version control")
                    .collapsible(false)
                    .resizable(false)
                    .show(ctx, |ui| {
                        ui.label("No git repository was found for this workspace.");
                        ui.label("Initialize one to enable history and automatic check-ins?");
                        ui.horizontal(|ui| {
                            if ui.button("Initialize").clicked() {
                                state.git_action = Some(GitAction::Init);
                                state.git_prompt_dismissed = true;
                            }
                            if ui.button("Not now").clicked() {
                                state.git_prompt_dismissed = true;
                            }
                        });
                    });
            }
            GitStatus::GitNotInstalled => {
                egui::Window::new("Version control")
                    .collapsible(false)
                    .resizable(false)
                    .show(ctx, |ui| {
                        ui.label("git was not found on this system.");
                        ui.label("Install git to enable version history and check-ins.");
                        if ui.button("OK").clicked() {
                            state.git_prompt_dismissed = true;
                        }
                    });
            }
            GitStatus::Ready(_) => {}
        }
    }

    if let Some(request) = state.pending_tag_removal.clone() {
        let mut cancel = false;
        let mut confirm = false;
        egui::Window::new("Remove tag")
            .collapsible(false)
            .resizable(false)
            .show(ctx, |ui| {
                ui.label(format!(
                    "Remove tag \"{}\" from table \"{}\"?",
                    request.tag, request.table
                ));
                ui.label(format!(
                    "{} word(s) use it; their values will be stripped.",
                    request.affected
                ));
                ui.label(RichText::new("A revertible check-in will be created.").weak());
                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        cancel = true;
                    }
                    if ui.button("Delete").clicked() {
                        confirm = true;
                    }
                });
            });

        if cancel {
            state.pending_tag_removal = None;
        } else if confirm {
            state.pending_tag_removal = None;
            match ws.remove_tag(&request.table, &request.tag) {
                Ok(Some(removal)) => {
                    state.status = Some(format!(
                        "Removed tag \"{}\" ({} values stripped)",
                        removal.tag, removal.affected
                    ));
                }
                Ok(None) => state.status = Some("Tag no longer exists".to_string()),
                Err(err) => state.status = Some(format!("Remove failed: {err}")),
            }
        }
    }

    dependency_dialog(ctx, ws, state);
    manual_convert_dialog(ctx, ws, state);
    parent_picker_dialog(ctx, ws, state);
}

#[derive(Clone, Copy)]
enum Resolution {
    Cancel,
    Auto,
    Manual,
    Continue,
}

fn dependency_dialog(ctx: &egui::Context, ws: &mut Workspace, state: &mut UiState) {
    let Some(prompt) = state.dependency_prompt.clone() else {
        return;
    };
    let mut resolution: Option<Resolution> = None;
    egui::Window::new("Dependency warning")
        .collapsible(false)
        .resizable(false)
        .show(ctx, |ui| {
            match &prompt.change {
                PendingChange::Rename { old, new, .. } => {
                    ui.label(format!("Rename \"{old}\" to \"{new}\"?"));
                }
                PendingChange::Delete { name, .. } => {
                    ui.label(format!("Delete \"{name}\"?"));
                }
            }
            ui.label(format!("{} word(s) depend on it:", prompt.dependents.len()));
            egui::ScrollArea::vertical()
                .max_height(160.0)
                .show(ui, |ui| {
                    for dep in &prompt.dependents {
                        ui.label(format!("• {} · {}", dep.wordname, dep.table));
                    }
                });
            ui.horizontal_wrapped(|ui| {
                if ui.button("Cancel").clicked() {
                    resolution = Some(Resolution::Cancel);
                }
                if ui.button("Auto-Convert (Risky)").clicked() {
                    resolution = Some(Resolution::Auto);
                }
                if ui.button("Manual…").clicked() {
                    resolution = Some(Resolution::Manual);
                }
                if ui.button("Continue Anyway").clicked() {
                    resolution = Some(Resolution::Continue);
                }
            });
        });

    if let Some(resolution) = resolution {
        apply_resolution(ws, state, &prompt, resolution);
    }
}

fn apply_resolution(
    ws: &mut Workspace,
    state: &mut UiState,
    prompt: &DependencyPrompt,
    resolution: Resolution,
) {
    let change = prompt.change.clone();
    state.dependency_prompt = None;

    match resolution {
        Resolution::Cancel => {
            if let PendingChange::Rename { table, id, old, .. } = &change {
                if let Some(entry) = ws.dictionary.get_entry_mut(table, *id) {
                    entry.wordname = old.clone();
                }
                state.rename_drafts.remove(&(table.clone(), *id));
            }
        }
        Resolution::Manual => {
            let is_delete = matches!(change, PendingChange::Delete { .. });
            let mut rows: Vec<ManualRow> = if is_delete {
                prompt
                    .dependents
                    .iter()
                    .map(|dep| ManualRow {
                        table: dep.table.clone(),
                        id: dep.id,
                        original: dep.wordname.clone(),
                        text: dep.wordname.clone(),
                        delete: false,
                    })
                    .collect()
            } else {
                derivation::descendants(&ws.dictionary, change.id())
                    .into_iter()
                    .map(|dep| ManualRow {
                        table: dep.table,
                        id: dep.id,
                        original: dep.wordname.clone(),
                        text: dep.wordname,
                        delete: false,
                    })
                    .collect()
            };
            if let PendingChange::Rename { table, id, new, .. } = &change {
                rows.insert(
                    0,
                    ManualRow {
                        table: table.clone(),
                        id: *id,
                        original: new.clone(),
                        text: new.clone(),
                        delete: false,
                    },
                );
            }
            state.manual_convert = Some(ManualConvert { change, rows });
        }
        Resolution::Continue => match &change {
            PendingChange::Rename { table, id, new, .. } => {
                if let Some(entry) = ws.dictionary.get_entry_mut(table, *id) {
                    entry.wordname = new.clone();
                }
                state.rename_drafts.remove(&(table.clone(), *id));
                save_table(ws, state, table);
                state.status = Some(format!(
                    "Renamed to \"{new}\"; {} dependent(s) kept their link",
                    prompt.dependents.len()
                ));
            }
            PendingChange::Delete { table, id, name } => {
                let _ = ws.delete_entry(table, *id);
                state.status = Some(format!(
                    "Deleted \"{name}\"; {} dependent(s) keep a dangling link",
                    prompt.dependents.len()
                ));
            }
        },
        Resolution::Auto => match &change {
            PendingChange::Rename {
                table,
                id,
                old,
                new,
            } => {
                let targets = derivation::plan_substring_rename(&ws.dictionary, *id, old, new);
                if let Some(entry) = ws.dictionary.get_entry_mut(table, *id) {
                    entry.wordname = new.clone();
                }
                derivation::apply_rename(&mut ws.dictionary, &targets);
                let mut tables = std::collections::BTreeSet::new();
                tables.insert(table.clone());
                for target in &targets {
                    tables.insert(target.table.clone());
                }
                for name in tables {
                    save_table(ws, state, &name);
                }
                state.rename_drafts.remove(&(table.clone(), *id));
                state.status = Some(format!(
                    "Renamed to \"{new}\"; {} descendant(s) auto-converted",
                    targets.len()
                ));
            }
            PendingChange::Delete { table, id, name } => {
                let children = derivation::direct_children(&ws.dictionary, *id);
                let _ = ws.delete_entry(table, *id);
                derivation::unlink_from_children(&mut ws.dictionary, *id);
                let mut tables = std::collections::BTreeSet::new();
                for child in &children {
                    tables.insert(child.table.clone());
                }
                for name in tables {
                    save_table(ws, state, &name);
                }
                state.status = Some(format!(
                    "Deleted \"{name}\"; unlinked {} child(ren)",
                    children.len()
                ));
            }
        },
    }
}

fn manual_convert_dialog(ctx: &egui::Context, ws: &mut Workspace, state: &mut UiState) {
    let Some(mut manual) = state.manual_convert.take() else {
        return;
    };
    let is_delete = matches!(manual.change, PendingChange::Delete { .. });
    let mut apply = false;
    let mut cancel = false;

    egui::Window::new("Manual convert")
        .collapsible(false)
        .resizable(true)
        .default_width(440.0)
        .show(ctx, |ui| {
            match &manual.change {
                PendingChange::Rename { old, new, .. } => {
                    ui.label(format!("Renaming \"{old}\" → \"{new}\". Adjust each name:"));
                }
                PendingChange::Delete { name, .. } => {
                    ui.label(format!("Deleting \"{name}\". Handle each dependent:"));
                }
            }
            ui.separator();
            egui::ScrollArea::vertical()
                .max_height(320.0)
                .show(ui, |ui| {
                    egui::Grid::new("manual_convert_rows")
                        .num_columns(2)
                        .striped(true)
                        .show(ui, |ui| {
                            for row in &mut manual.rows {
                                if is_delete {
                                    ui.label(&row.original);
                                    ui.checkbox(&mut row.delete, "also delete");
                                } else {
                                    ui.label(RichText::new(&row.original).weak());
                                    ui.add(
                                        egui::TextEdit::singleline(&mut row.text)
                                            .desired_width(240.0),
                                    );
                                }
                                ui.end_row();
                            }
                        });
                });
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("Apply").clicked() {
                    apply = true;
                }
                if ui.button("Cancel").clicked() {
                    cancel = true;
                }
            });
        });

    if apply {
        apply_manual_convert(ws, state, &manual);
    } else if cancel {
        if let PendingChange::Rename { table, id, .. } = &manual.change {
            state.rename_drafts.remove(&(table.clone(), *id));
        }
    } else {
        state.manual_convert = Some(manual);
    }
}

fn apply_manual_convert(ws: &mut Workspace, state: &mut UiState, manual: &ManualConvert) {
    match &manual.change {
        PendingChange::Rename { table, id, .. } => {
            let mut tables = std::collections::BTreeSet::new();
            tables.insert(table.clone());
            for row in &manual.rows {
                if let Some(entry) = ws.dictionary.get_entry_mut(&row.table, row.id) {
                    entry.wordname = row.text.clone();
                }
                tables.insert(row.table.clone());
            }
            for name in tables {
                save_table(ws, state, &name);
            }
            state.rename_drafts.remove(&(table.clone(), *id));
            state.status = Some(format!(
                "Manual rename applied to {} word(s)",
                manual.rows.len()
            ));
        }
        PendingChange::Delete { table, id, name } => {
            let _ = ws.delete_entry(table, *id);
            derivation::unlink_from_children(&mut ws.dictionary, *id);
            let mut tables = std::collections::BTreeSet::new();
            for row in &manual.rows {
                tables.insert(row.table.clone());
                if row.delete {
                    let _ = ws.delete_entry(&row.table, row.id);
                }
            }
            for table in tables {
                save_table(ws, state, &table);
            }
            state.status = Some(format!(
                "Deleted \"{name}\"; {} dependent(s) handled manually",
                manual.rows.len()
            ));
        }
    }
}

fn parent_picker_dialog(ctx: &egui::Context, ws: &mut Workspace, state: &mut UiState) {
    let Some(mut picker) = state.parent_picker.take() else {
        return;
    };
    let mut chosen: Option<Uuid> = None;
    let mut close = false;

    egui::Window::new("Add parent")
        .collapsible(false)
        .resizable(true)
        .default_width(380.0)
        .show(ctx, |ui| {
            ui.add(
                egui::TextEdit::singleline(&mut picker.filter)
                    .hint_text("search words")
                    .desired_width(f32::INFINITY),
            );
            let needle = picker.filter.trim().to_lowercase();
            let candidates = derivation::parent_candidates(&ws.dictionary, picker.child);
            egui::ScrollArea::vertical()
                .max_height(280.0)
                .show(ui, |ui| {
                    let mut shown = 0;
                    for candidate in &candidates {
                        if !needle.is_empty()
                            && !candidate.wordname.to_lowercase().contains(&needle)
                        {
                            continue;
                        }
                        shown += 1;
                        if ui
                            .selectable_label(
                                false,
                                format!("{}  ·  {}", candidate.wordname, candidate.table),
                            )
                            .clicked()
                        {
                            chosen = Some(candidate.id);
                        }
                    }
                    if shown == 0 {
                        ui.label(RichText::new("No candidates.").weak());
                    }
                });
            if ui.button("Close").clicked() {
                close = true;
            }
        });

    if let Some(parent) = chosen {
        if ws
            .dictionary
            .add_parent(&picker.table, picker.child, parent)
        {
            save_table(ws, state, &picker.table);
            state.status = Some("Added parent".to_string());
        } else {
            state.status = Some("Cannot add parent: would create a cycle".to_string());
        }
    }

    if !close {
        state.parent_picker = Some(picker);
    }
}

fn save_table(ws: &mut Workspace, state: &mut UiState, table: &str) {
    if let Err(err) = ws.save_table_edits(table) {
        state.status = Some(format!("Save failed: {err}"));
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

fn short(id: &str) -> &str {
    &id[..7.min(id.len())]
}
