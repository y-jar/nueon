//! Shared application state owned by the Tauri runtime.

use std::path::{Path, PathBuf};

use langloom_core::global::GlobalConfig;
use langloom_core::{StorageError, Workspace};

/// State shared across commands.
#[derive(Default)]
pub struct AppState {
    /// App-global workspace registry.
    pub global: GlobalConfig,
    /// The currently open workspace, if any.
    pub workspace: Option<Workspace>,
}

impl AppState {
    /// Load the registry and try to reopen the last-used workspace.
    ///
    /// Workspaces whose directory has vanished are pruned from the registry
    /// rather than silently re-created, so the UI falls back to onboarding.
    pub fn load() -> Self {
        let mut global = GlobalConfig::load_default();
        let mut pruned = false;

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(last) = global.last.clone() {
            candidates.push(last);
        }
        candidates.extend(global.workspaces.iter().map(|entry| entry.path.clone()));

        let mut workspace = None;
        for path in candidates {
            match Workspace::open(&path) {
                Ok(opened) => {
                    workspace = Some(opened);
                    break;
                }
                Err(StorageError::NotFound(_)) => {
                    global.remove(&path);
                    pruned = true;
                }
                Err(_) => {}
            }
        }

        if pruned {
            let _ = global.save();
        }
        Self { global, workspace }
    }

    /// The open workspace, or an error string.
    pub fn workspace(&self) -> Result<&Workspace, String> {
        self.workspace
            .as_ref()
            .ok_or_else(|| "no workspace is open".to_string())
    }

    /// The open workspace, mutably, or an error string.
    pub fn workspace_mut(&mut self) -> Result<&mut Workspace, String> {
        self.workspace
            .as_mut()
            .ok_or_else(|| "no workspace is open".to_string())
    }
}

/// A display name for a workspace path (its folder name).
pub fn default_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}
