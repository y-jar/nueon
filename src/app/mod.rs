//! The egui application shell.

pub mod state;
pub mod theme;

mod markdown;
mod note_editor;
mod note_tree;
mod panels;
mod tab_viewer;
mod translation_builder;
mod translation_run;
mod workspaces;

pub use state::{Tab, UiState};

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use egui::{Key, Modifiers};
use egui_dock::{DockArea, DockState};

use crate::global::GlobalConfig;
use crate::vcs::GitStatus;
use crate::workspace::Workspace;

use state::{GitAction, WorkspaceAction};
use tab_viewer::AppTabViewer;

/// The root application state.
pub struct LangloomApp {
    dock: DockState<Tab>,
    workspace: Option<Workspace>,
    global: GlobalConfig,
    state: UiState,
}

impl LangloomApp {
    /// Create the app, opening the requested workspace or the last-known one.
    pub fn new(mut global: GlobalConfig, requested: Option<PathBuf>) -> Self {
        let mut state = UiState::new();
        let workspace = resolve_workspace(&mut global, requested, &mut state);
        if let Err(err) = global.save() {
            state.status = Some(format!("Could not save config: {err}"));
        }
        Self {
            dock: DockState::new(vec![Tab::Welcome]),
            workspace,
            global,
            state,
        }
    }

    fn open_tab(&mut self, tab: Tab) {
        if let Some(path) = self.dock.find_tab(&tab) {
            let _ = self.dock.set_active_tab(path);
        } else {
            self.dock.push_to_focused_leaf(tab);
        }
    }

    fn drain_open_tabs(&mut self) {
        for tab in std::mem::take(&mut self.state.open_tabs) {
            self.open_tab(tab);
        }
    }

    fn switch_workspace(&mut self, path: PathBuf) {
        match Workspace::load(&path) {
            Ok(workspace) => {
                self.workspace = Some(workspace);
                self.dock = DockState::new(vec![Tab::Welcome]);
                self.state = UiState::new();
                self.state.status = Some(format!("Opened {}", path.display()));
                self.global.add(path.clone(), default_name(&path));
                self.global.last = Some(path);
                if let Err(err) = self.global.save() {
                    self.state.status = Some(format!("Config save failed: {err}"));
                }
            }
            Err(err) => {
                self.state.status = Some(format!("Failed to open {}: {err}", path.display()));
            }
        }
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        let mut save = false;
        let ctrl_shift = Modifiers {
            ctrl: true,
            shift: true,
            ..Default::default()
        };
        ctx.input_mut(|input| {
            if input.consume_key(Modifiers::CTRL, Key::K) {
                self.state.focus_command = true;
            }
            if input.consume_key(ctrl_shift, Key::G) {
                self.state.git_panel_open = !self.state.git_panel_open;
            }
            if input.consume_key(Modifiers::CTRL, Key::T) {
                self.state.request_tab(Tab::Translation);
            }
            if input.consume_key(Modifiers::CTRL, Key::E) {
                self.state.raw_mode = !self.state.raw_mode;
                self.state.note_edit = None;
            }
            if input.consume_key(Modifiers::CTRL, Key::S) {
                save = true;
            }
        });
        if save {
            self.save_active_note();
        }
    }

    fn save_active_note(&mut self) {
        let Some(workspace) = self.workspace.as_mut() else {
            return;
        };
        let Some(path) = self.state.selected_note.clone() else {
            return;
        };
        let Some(note) = workspace.notes.iter().find(|n| n.path == path).cloned() else {
            return;
        };
        match workspace.save_note(&note) {
            Ok(()) => self.state.status = Some(format!("Saved {}", path.display())),
            Err(err) => self.state.status = Some(format!("Save failed: {err}")),
        }
    }

    fn tick(&mut self, ctx: &egui::Context) {
        let Some(workspace) = self.workspace.as_mut() else {
            return;
        };
        if let Some(commit) = workspace.pump_auto_checkin(Instant::now()) {
            self.state.status = Some(format!("Checked in {}", short(&commit)));
        }
        if workspace.settings.auto_checkin && matches!(workspace.vcs, GitStatus::Ready(_)) {
            ctx.request_repaint_after(Duration::from_secs(5));
        }
    }

    fn apply_actions(&mut self) {
        if let Some(workspace) = self.workspace.as_mut() {
            if let Some((table, child, parent)) = self.state.remove_parent.take() {
                if workspace.dictionary.remove_parent(&table, child, parent) {
                    if let Err(err) = workspace.save_table_edits(&table) {
                        self.state.status = Some(format!("Save failed: {err}"));
                    }
                }
            }

            if let Some((enabled, secs)) = self.state.set_auto_checkin.take() {
                workspace.set_auto_checkin(enabled, secs);
                if let Err(err) = workspace.save_config() {
                    self.state.status = Some(format!("Save settings failed: {err}"));
                }
            }

            if let Some(action) = self.state.git_action.take() {
                match action {
                    GitAction::Init => match workspace.init_git() {
                        Ok(()) => {
                            self.state.status = Some("Git repository initialized".to_string())
                        }
                        Err(err) => self.state.status = Some(format!("Git init failed: {err}")),
                    },
                    GitAction::Checkin(message) => {
                        let message = if message.trim().is_empty() {
                            "langloom: manual check-in".to_string()
                        } else {
                            message
                        };
                        match workspace.checkin(&message) {
                            Some(id) => {
                                self.state.status = Some(format!("Checked in {}", short(&id)));
                                self.state.commit_message.clear();
                            }
                            None => self.state.status = Some("Nothing to check in".to_string()),
                        }
                    }
                }
            }
        } else {
            self.state.remove_parent = None;
            self.state.set_auto_checkin = None;
            self.state.git_action = None;
        }

        if let Some(action) = self.state.workspace_action.take() {
            self.apply_workspace_action(action);
        }
    }

    fn apply_workspace_action(&mut self, action: WorkspaceAction) {
        match action {
            WorkspaceAction::Open(path) => self.switch_workspace(path),
            WorkspaceAction::Create { name, destination } => {
                let target = destination.join(&name);
                match Workspace::new(&target) {
                    Ok(workspace) => {
                        self.workspace = Some(workspace);
                        self.dock = DockState::new(vec![Tab::Welcome]);
                        self.state = UiState::new();
                        self.state.status = Some(format!("Created {}", target.display()));
                        self.global.add(target.clone(), name);
                        self.global.last = Some(target);
                        let _ = self.global.save();
                    }
                    Err(err) => self.state.status = Some(format!("Create failed: {err}")),
                }
            }
            WorkspaceAction::Remove(path) => {
                self.global.remove(&path);
                if self
                    .workspace
                    .as_ref()
                    .is_some_and(|workspace| workspace.root_path == path)
                {
                    self.workspace = None;
                    self.dock = DockState::new(vec![Tab::Welcome]);
                }
                let _ = self.global.save();
                self.state.status = Some(format!("Removed {} from list", path.display()));
            }
            WorkspaceAction::Rename { path, name } => {
                self.global.rename(&path, name);
                let _ = self.global.save();
            }
            WorkspaceAction::EditPath { from, to } => {
                self.global.set_path(&from, to);
                let _ = self.global.save();
            }
            WorkspaceAction::DeleteFromDisk(path) => match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    self.global.remove(&path);
                    if self
                        .workspace
                        .as_ref()
                        .is_some_and(|workspace| workspace.root_path == path)
                    {
                        self.workspace = None;
                        self.dock = DockState::new(vec![Tab::Welcome]);
                    }
                    let _ = self.global.save();
                    self.state.status = Some(format!("Deleted {}", path.display()));
                }
                Err(err) => self.state.status = Some(format!("Delete failed: {err}")),
            },
        }
    }
}

impl eframe::App for LangloomApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.tick(&ctx);
        self.handle_shortcuts(&ctx);

        if self.workspace.is_none() {
            egui::CentralPanel::default().show(ui, |ui| {
                workspaces::onboarding(ui, &mut self.state);
            });
        } else {
            egui::Panel::top("command_bar").show(ui, |ui| {
                panels::command_bar(ui, self.workspace.as_ref().unwrap(), &mut self.state);
            });

            if self.state.git_panel_open {
                egui::Panel::right("git_panel")
                    .default_size(260.0)
                    .show(ui, |ui| {
                        panels::git_panel(ui, self.workspace.as_ref().unwrap(), &mut self.state);
                    });
            }

            egui::Panel::left("sidebar")
                .default_size(220.0)
                .show(ui, |ui| {
                    egui::Panel::bottom("workspace_switcher").show(ui, |ui| {
                        workspaces::switcher(ui, &self.global, &mut self.state);
                    });
                    panels::sidebar(ui, self.workspace.as_mut().unwrap(), &mut self.state);
                });

            egui::Panel::right("inspector")
                .default_size(240.0)
                .show(ui, |ui| {
                    panels::inspector(ui, self.workspace.as_mut().unwrap(), &mut self.state);
                });

            egui::CentralPanel::default().show(ui, |ui| {
                let LangloomApp {
                    dock,
                    workspace,
                    state,
                    ..
                } = self;
                let workspace = workspace.as_mut().expect("workspace present");
                let mut viewer = AppTabViewer { workspace, state };
                DockArea::new(dock).show_inside(ui, &mut viewer);
            });

            if let Some(workspace) = self.workspace.as_mut() {
                panels::dialogs(&ctx, workspace, &mut self.state);
            }
        }

        workspaces::manage_dialog(&ctx, &self.global, &mut self.state);
        self.apply_actions();
        self.drain_open_tabs();
    }
}

fn resolve_workspace(
    global: &mut GlobalConfig,
    requested: Option<PathBuf>,
    state: &mut UiState,
) -> Option<Workspace> {
    let candidate = requested
        .or_else(|| global.last.clone())
        .or_else(|| global.workspaces.first().map(|entry| entry.path.clone()))?;
    match Workspace::load(&candidate) {
        Ok(workspace) => {
            global.add(candidate.clone(), default_name(&candidate));
            global.last = Some(candidate);
            Some(workspace)
        }
        Err(err) => {
            state.status = Some(format!("Failed to open {}: {err}", candidate.display()));
            None
        }
    }
}

fn default_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn short(id: &str) -> &str {
    &id[..7.min(id.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_builds_from_a_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::load(dir.path()).unwrap();
        let app = LangloomApp {
            dock: DockState::new(vec![Tab::Welcome]),
            workspace: Some(workspace),
            global: GlobalConfig::default(),
            state: UiState::new(),
        };
        assert_eq!(app.dock.iter_all_tabs().count(), 1);
    }

    #[test]
    fn app_builds_without_a_workspace() {
        let app = LangloomApp {
            dock: DockState::new(vec![Tab::Welcome]),
            workspace: None,
            global: GlobalConfig::default(),
            state: UiState::new(),
        };
        assert!(app.workspace.is_none());
    }
}
