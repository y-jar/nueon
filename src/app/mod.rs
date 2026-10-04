//! The egui application shell.

pub mod state;
pub mod theme;

mod markdown;
mod note_editor;
mod panels;
mod tab_viewer;
mod translation_builder;

pub use state::{Tab, UiState};

use std::time::{Duration, Instant};

use egui::{Key, Modifiers};
use egui_dock::{DockArea, DockState};

use crate::vcs::GitStatus;
use crate::workspace::Workspace;

use state::GitAction;
use tab_viewer::AppTabViewer;

/// The root application state.
pub struct LangjarApp {
    dock: DockState<Tab>,
    workspace: Workspace,
    state: UiState,
}

impl LangjarApp {
    /// Create the app with an open workspace.
    pub fn new(workspace: Workspace) -> Self {
        Self {
            dock: DockState::new(vec![Tab::Welcome]),
            workspace,
            state: UiState::new(),
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
        let Some(path) = self.state.selected_note.clone() else {
            return;
        };
        let Some(note) = self
            .workspace
            .notes
            .iter()
            .find(|n| n.path == path)
            .cloned()
        else {
            return;
        };
        match self.workspace.save_note(&note) {
            Ok(()) => self.state.status = Some(format!("Saved {}", path.display())),
            Err(err) => self.state.status = Some(format!("Save failed: {err}")),
        }
    }

    fn tick(&mut self, ctx: &egui::Context) {
        if let Some(commit) = self.workspace.pump_auto_checkin(Instant::now()) {
            self.state.status = Some(format!("Checked in {}", short(&commit)));
        }
        if self.workspace.settings.auto_checkin && matches!(self.workspace.vcs, GitStatus::Ready(_))
        {
            ctx.request_repaint_after(Duration::from_secs(5));
        }
    }

    fn apply_actions(&mut self) {
        if let Some((table, child, parent)) = self.state.remove_parent.take() {
            if self
                .workspace
                .dictionary
                .remove_parent(&table, child, parent)
            {
                if let Err(err) = self.workspace.save_table_edits(&table) {
                    self.state.status = Some(format!("Save failed: {err}"));
                }
            }
        }

        if let Some((enabled, secs)) = self.state.set_auto_checkin.take() {
            self.workspace.set_auto_checkin(enabled, secs);
            if let Err(err) = self.workspace.save_config() {
                self.state.status = Some(format!("Save settings failed: {err}"));
            }
        }

        if let Some(action) = self.state.git_action.take() {
            match action {
                GitAction::Init => match self.workspace.init_git() {
                    Ok(()) => self.state.status = Some("Git repository initialized".to_string()),
                    Err(err) => self.state.status = Some(format!("Git init failed: {err}")),
                },
                GitAction::Checkin(message) => {
                    let message = if message.trim().is_empty() {
                        "langjar: manual check-in".to_string()
                    } else {
                        message
                    };
                    match self.workspace.checkin(&message) {
                        Some(id) => {
                            self.state.status = Some(format!("Checked in {}", short(&id)));
                            self.state.commit_message.clear();
                        }
                        None => self.state.status = Some("Nothing to check in".to_string()),
                    }
                }
            }
        }
    }
}

impl eframe::App for LangjarApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.tick(&ctx);
        self.handle_shortcuts(&ctx);

        egui::Panel::top("command_bar").show(ui, |ui| {
            panels::command_bar(ui, &self.workspace, &mut self.state);
        });

        if self.state.git_panel_open {
            egui::Panel::right("git_panel")
                .default_size(260.0)
                .show(ui, |ui| {
                    panels::git_panel(ui, &self.workspace, &mut self.state);
                });
        }

        egui::Panel::left("sidebar")
            .default_size(220.0)
            .show(ui, |ui| {
                panels::sidebar(ui, &mut self.workspace, &mut self.state);
            });

        egui::Panel::right("inspector")
            .default_size(240.0)
            .show(ui, |ui| {
                panels::inspector(ui, &mut self.workspace, &mut self.state);
            });

        egui::CentralPanel::default().show(ui, |ui| {
            let LangjarApp {
                dock,
                workspace,
                state,
            } = self;
            let mut viewer = AppTabViewer { workspace, state };
            DockArea::new(dock).show_inside(ui, &mut viewer);
        });

        panels::dialogs(&ctx, &mut self.workspace, &mut self.state);
        self.apply_actions();
        self.drain_open_tabs();
    }
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
        let app = LangjarApp::new(workspace);
        assert_eq!(app.dock.iter_all_tabs().count(), 1);
    }
}
