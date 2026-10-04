//! Shared application state owned by the Tauri runtime.

use std::path::Path;

use langloom_core::global::GlobalConfig;
use langloom_core::Workspace;

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
    pub fn load() -> Self {
        let global = GlobalConfig::load_default();
        let workspace = global
            .last
            .as_deref()
            .and_then(|path| Workspace::load(path).ok())
            .or_else(|| {
                global
                    .workspaces
                    .first()
                    .and_then(|entry| Workspace::load(&entry.path).ok())
            });
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
