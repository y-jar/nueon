//! Shared application state owned by the Tauri runtime.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use nueon_core::font::PreviewCache;
use nueon_core::global::GlobalConfig;
use nueon_core::{StorageError, Workspace};

/// State shared across commands.
#[derive(Default)]
pub struct AppState {
    /// App-global workspace registry.
    pub global: GlobalConfig,
    /// The currently open workspace, if any.
    pub workspace: Option<Workspace>,
    /// The workspace root the asset protocol is currently scoped to, so a
    /// switch can forbid exactly what the previous workspace allowed.
    pub asset_root: Option<PathBuf>,
    /// One-use grants for paths the OS handed the app (drag-dropped files).
    /// A path JavaScript invented has no grant and is refused.
    pub granted_paths: Vec<PathBuf>,
    /// A tracing image chosen in a dialog, kept for one confirm retry.
    pub pending_back_image: Option<(String, PathBuf)>,
    /// Secondary windows being closed by the app itself (quit or workspace
    /// switch); their saved layout is kept instead of pruned.
    pub silent_close: HashSet<String>,
    /// The last compiled type-preview font, reused until the font would change.
    pub preview_font: PreviewCache,
}

/// Point the webview's asset protocol at exactly the open workspace. The
/// config's scope starts empty, so nothing on the host is reachable until a
/// workspace opens; switching forbids the old root and allows the new one
/// (a forbid always beats an allow in Tauri's scope resolution).
pub fn refresh_asset_scope(app: &tauri::AppHandle, state: &mut AppState) {
    use tauri::Manager;
    let scope = app.asset_protocol_scope();
    if let Some(old) = state.asset_root.take() {
        let _ = scope.forbid_directory(&old, true);
    }
    let root = state.workspace.as_ref().map(|w| w.root_path.clone());
    if let Some(root) = &root {
        let _ = scope.allow_directory(root, true);
    }
    state.asset_root = root;
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
        Self {
            global,
            workspace,
            silent_close: HashSet::new(),
            preview_font: PreviewCache::default(),
            asset_root: None,
            granted_paths: Vec::new(),
            pending_back_image: None,
        }
    }

    /// Consume a one-use grant for a path the OS handed the app.
    pub fn consume_grant(&mut self, path: &Path) -> bool {
        match self.granted_paths.iter().position(|p| p == path) {
            Some(at) => {
                self.granted_paths.remove(at);
                true
            }
            None => false,
        }
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
