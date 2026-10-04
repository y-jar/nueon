//! Top command bar, left sidebar, inspector, git panel, and dialogs.

use egui::{RichText, Ui};

use super::state::{parse_command, CommandFilter, GitAction, Tab, UiState, WordRef};
use crate::model::FieldValue;
use crate::vcs::GitStatus;
use crate::workspace::Workspace;

const ERROR: egui::Color32 = egui::Color32::from_rgb(214, 120, 90);
const CHANGED: egui::Color32 = egui::Color32::from_rgb(206, 176, 110);

/// The global command & search bar.
pub fn command_bar(ui: &mut Ui, ws: &Workspace, state: &mut UiState) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("langjar").strong().size(16.0));
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
pub fn inspector(ui: &mut Ui, ws: &Workspace, state: &mut UiState) {
    ui.heading("Inspector");

    if let Some(word) = state.selected_word.clone() {
        let Some(entry) = ws.dictionary.get_entry(&word.table, word.id) else {
            state.selected_word = None;
            ui.label(RichText::new("Selection no longer exists.").weak());
            return;
        };

        ui.label(RichText::new(&entry.wordname).strong().size(18.0));
        ui.label(RichText::new(format!("table: {}", word.table)).weak());
        ui.separator();
        if entry.values.is_empty() {
            ui.label(RichText::new("No tags applied.").weak());
        }
        for (name, value) in &entry.values {
            ui.horizontal(|ui| {
                ui.strong(name);
                ui.label(display_value(value));
            });
        }
        if let Some(parent) = entry.parent() {
            if let Some((table, root)) = ws.dictionary.find_entry(parent) {
                ui.separator();
                ui.label(format!("derived from: {} · {table}", root.wordname));
            }
        }
        let children = ws.dictionary.children_of(entry.id).len();
        ui.label(RichText::new(format!("direct derivatives: {children}")).weak());
    } else if let Some(note) = &state.selected_note {
        ui.label(format!("note: {}", note.display()));
    } else {
        ui.label(RichText::new("Select a word or note.").weak());
    }
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
}

fn display_value(value: &FieldValue) -> String {
    match value {
        FieldValue::Text(text) => text.clone(),
        FieldValue::Boolean(flag) => flag.to_string(),
        FieldValue::TagList(list) => list.join(", "),
        FieldValue::Reference(id) => format!("→ {id}"),
    }
}

fn short(id: &str) -> &str {
    &id[..7.min(id.len())]
}
