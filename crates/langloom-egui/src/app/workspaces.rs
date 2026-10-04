//! Workspace onboarding, switcher dropdown, and the manage wizard.

use std::path::PathBuf;

use egui::{RichText, Ui};

use crate::global::GlobalConfig;

use super::state::{UiState, WorkspaceAction};

/// The onboarding screen shown when no workspace is open.
pub fn onboarding(ui: &mut Ui, state: &mut UiState) {
    ui.vertical_centered(|ui| {
        ui.add_space(80.0);
        ui.heading("langloom");
        ui.label("A conlang editor and creation app.");
        ui.add_space(12.0);
        if ui.button("Manage workspaces…").clicked() {
            state.wizard.open = true;
        }
    });
}

/// The bottom-pinned workspace switcher.
pub fn switcher(ui: &mut Ui, global: &GlobalConfig, state: &mut UiState) {
    ui.label(RichText::new("Workspace").weak());
    let current = global
        .active()
        .map(GlobalConfig::display_name)
        .unwrap_or_else(|| "Open workspace".to_string());
    ui.menu_button(format!("⌄ {current}"), |ui| {
        if global.workspaces.is_empty() {
            ui.label(RichText::new("No workspaces.").weak());
        }
        for entry in &global.workspaces {
            let active = global.active().is_some_and(|a| a.path == entry.path);
            if ui
                .selectable_label(active, GlobalConfig::display_name(entry))
                .clicked()
            {
                state.workspace_action = Some(WorkspaceAction::Open(entry.path.clone()));
                ui.close();
            }
        }
        ui.separator();
        if ui.button("Manage workspaces…").clicked() {
            state.wizard.open = true;
            ui.close();
        }
    });
}

/// The workspace manager wizard.
pub fn manage_dialog(ctx: &egui::Context, global: &GlobalConfig, state: &mut UiState) {
    if !state.wizard.open {
        return;
    }

    let mut open = state.wizard.open;
    egui::Window::new("Manage workspaces")
        .collapsible(false)
        .resizable(true)
        .default_width(600.0)
        .open(&mut open)
        .show(ctx, |ui| {
            ui.horizontal_top(|ui| {
                ui.vertical(|ui| {
                    ui.set_min_width(260.0);
                    ui.label(RichText::new("Workspaces").strong());
                    if global.workspaces.is_empty() {
                        ui.label(RichText::new("None yet.").weak());
                    }
                    for entry in &global.workspaces {
                        ui.horizontal(|ui| {
                            let active = global.active().is_some_and(|a| a.path == entry.path);
                            if ui
                                .selectable_label(active, GlobalConfig::display_name(entry))
                                .clicked()
                            {
                                state.workspace_action =
                                    Some(WorkspaceAction::Open(entry.path.clone()));
                            }
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    ui.menu_button("⋮", |ui| {
                                        if ui.button("Open").clicked() {
                                            state.workspace_action =
                                                Some(WorkspaceAction::Open(entry.path.clone()));
                                            ui.close();
                                        }
                                        if ui.button("Rename…").clicked() {
                                            state.wizard.editing = Some(entry.path.clone());
                                            state.wizard.edit_name = entry.name.clone();
                                            state.wizard.edit_path =
                                                entry.path.display().to_string();
                                            ui.close();
                                        }
                                        if ui.button("Remove from list").clicked() {
                                            state.workspace_action =
                                                Some(WorkspaceAction::Remove(entry.path.clone()));
                                            ui.close();
                                        }
                                        if ui.button("Delete from disk…").clicked() {
                                            state.wizard.confirm_delete = Some(entry.path.clone());
                                            ui.close();
                                        }
                                    });
                                },
                            );
                        });
                    }

                    if let Some(path) = state.wizard.editing.clone() {
                        ui.separator();
                        ui.label(format!("Editing {}", path.display()));
                        ui.add(
                            egui::TextEdit::singleline(&mut state.wizard.edit_name)
                                .hint_text("name")
                                .desired_width(f32::INFINITY),
                        );
                        ui.add(
                            egui::TextEdit::singleline(&mut state.wizard.edit_path)
                                .hint_text("path")
                                .desired_width(f32::INFINITY),
                        );
                        ui.horizontal(|ui| {
                            if ui.button("Save").clicked() {
                                let name = state.wizard.edit_name.trim().to_string();
                                let new_path = PathBuf::from(state.wizard.edit_path.trim());
                                if !name.is_empty() {
                                    state.workspace_action = Some(WorkspaceAction::Rename {
                                        path: path.clone(),
                                        name,
                                    });
                                }
                                if !new_path.as_os_str().is_empty() && new_path != path {
                                    state.workspace_action = Some(WorkspaceAction::EditPath {
                                        from: path.clone(),
                                        to: new_path,
                                    });
                                }
                                state.wizard.editing = None;
                            }
                            if ui.button("Cancel").clicked() {
                                state.wizard.editing = None;
                            }
                        });
                    }
                });

                ui.separator();

                ui.vertical(|ui| {
                    ui.label(RichText::new("Create new").strong());
                    ui.add(
                        egui::TextEdit::singleline(&mut state.wizard.create_name)
                            .hint_text("name")
                            .desired_width(f32::INFINITY),
                    );
                    ui.horizontal(|ui| {
                        ui.add(
                            egui::TextEdit::singleline(&mut state.wizard.create_dest)
                                .hint_text("destination folder")
                                .desired_width(200.0),
                        );
                        if ui.button("Browse…").clicked() {
                            if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                                state.wizard.create_dest = folder.display().to_string();
                            }
                        }
                    });
                    if ui.button("Create").clicked() {
                        let name = state.wizard.create_name.trim().to_string();
                        let dest = state.wizard.create_dest.trim();
                        if name.is_empty() || dest.is_empty() {
                            state.status = Some("Name and destination are required".to_string());
                        } else {
                            state.workspace_action = Some(WorkspaceAction::Create {
                                name,
                                destination: PathBuf::from(dest),
                            });
                        }
                    }

                    ui.separator();
                    ui.label(RichText::new("Open existing").strong());
                    ui.horizontal(|ui| {
                        ui.add(
                            egui::TextEdit::singleline(&mut state.wizard.existing_path)
                                .hint_text("folder path")
                                .desired_width(200.0),
                        );
                        if ui.button("Browse…").clicked() {
                            if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                                state.wizard.existing_path = folder.display().to_string();
                            }
                        }
                    });
                    if ui.button("Open").clicked() {
                        let path = state.wizard.existing_path.trim();
                        if path.is_empty() {
                            state.status = Some("Path is required".to_string());
                        } else {
                            state.workspace_action =
                                Some(WorkspaceAction::Open(PathBuf::from(path)));
                        }
                    }
                });
            });
        });
    state.wizard.open = open;

    if let Some(path) = state.wizard.confirm_delete.clone() {
        let mut confirm = false;
        let mut cancel = false;
        egui::Window::new("Delete workspace")
            .collapsible(false)
            .resizable(false)
            .show(ctx, |ui| {
                ui.label(format!("Delete \"{}\" from disk?", path.display()));
                ui.label(RichText::new("This permanently removes the folder.").weak());
                ui.horizontal(|ui| {
                    if ui.button("Delete").clicked() {
                        confirm = true;
                    }
                    if ui.button("Cancel").clicked() {
                        cancel = true;
                    }
                });
            });
        if cancel {
            state.wizard.confirm_delete = None;
        }
        if confirm {
            state.wizard.confirm_delete = None;
            state.workspace_action = Some(WorkspaceAction::DeleteFromDisk(path));
        }
    }
}
