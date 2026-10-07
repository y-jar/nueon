//! Version-control commands and auto-check-in control.

use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, State};

use nueon_core::vcs::GitStatus;
use nueon_core::{Commit, StatusEntry};

use super::changed;
use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Detected VCS state for the workspace.
#[derive(Debug, Clone, Serialize)]
pub struct VcsInfo {
    /// `ready`, `not_a_repo`, or `git_missing`.
    pub state: String,
    pub branch: Option<String>,
}

/// Auto-check-in settings.
#[derive(Debug, Clone, Serialize)]
pub struct AutoCheckinInfo {
    pub enabled: bool,
    pub secs: u64,
}

/// Detected VCS state (`ready` / `not_a_repo` / `git_missing`) and branch.
#[tauri::command]
pub fn vcs_state(state: State<'_, Shared>) -> Result<VcsInfo, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(match &workspace.vcs {
        GitStatus::GitNotInstalled => VcsInfo {
            state: "git_missing".to_string(),
            branch: None,
        },
        GitStatus::NotARepo => VcsInfo {
            state: "not_a_repo".to_string(),
            branch: None,
        },
        GitStatus::Ready(repo) => VcsInfo {
            state: "ready".to_string(),
            branch: repo.branch().ok(),
        },
    })
}

/// Working-tree status entries.
#[tauri::command]
pub fn vcs_status(state: State<'_, Shared>) -> Result<Vec<StatusEntry>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    match workspace.git() {
        Some(repo) => repo.status().map_err(|err| err.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Recent commits, newest first, up to `limit`.
#[tauri::command]
pub fn vcs_log(state: State<'_, Shared>, limit: usize) -> Result<Vec<Commit>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    match workspace.git() {
        Some(repo) => repo.log(limit).map_err(|err| err.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Diff of the working tree, optionally scoped to one `path`.
#[tauri::command]
pub fn vcs_diff(state: State<'_, Shared>, path: Option<String>) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    match workspace.git() {
        Some(repo) => repo.diff(path.as_deref()).map_err(|err| err.to_string()),
        None => Ok(String::new()),
    }
}

/// The diff introduced by commit `id`.
#[tauri::command]
pub fn vcs_show(state: State<'_, Shared>, id: String) -> Result<String, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    match workspace.git() {
        Some(repo) => repo.show(&id).map_err(|err| err.to_string()),
        None => Ok(String::new()),
    }
}

/// Local branch names.
#[tauri::command]
pub fn vcs_branches(state: State<'_, Shared>) -> Result<Vec<String>, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    match workspace.git() {
        Some(repo) => repo.branches().map_err(|err| err.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Check out a branch and reload the in-memory workspace.
#[tauri::command]
pub fn vcs_checkout(app: AppHandle, state: State<'_, Shared>, name: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    if let Some(repo) = workspace.git() {
        repo.checkout(&name).map_err(|err| err.to_string())?;
    }
    // Files changed on disk: refresh the in-memory copy before any save.
    workspace
        .reload_disk_state()
        .map_err(|err| err.to_string())?;
    drop(state);
    changed_after_disk_change(&app);
    Ok(())
}

/// Tell every window that files changed behind the app's back.
fn changed_after_disk_change(app: &AppHandle) {
    changed(app, "notes");
    changed(app, "dictionary");
    changed(app, "vcs");
}

/// Create a new branch.
#[tauri::command]
pub fn vcs_create_branch(
    app: AppHandle,
    state: State<'_, Shared>,
    name: String,
) -> Result<(), String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    if let Some(repo) = workspace.git() {
        repo.create_branch(&name).map_err(|err| err.to_string())?;
    }
    drop(state);
    changed(&app, "vcs");
    Ok(())
}

/// Whether the one-time git prompt has been silenced.
#[tauri::command]
pub fn git_prompt_dismissed(state: State<'_, Shared>) -> Result<bool, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    Ok(state.workspace()?.settings.git_prompt_dismissed)
}

/// Persist the git-prompt dismissal.
#[tauri::command]
pub fn git_prompt_dismissed_set(
    app: AppHandle,
    state: State<'_, Shared>,
    dismissed: bool,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .set_git_prompt_dismissed(dismissed)
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "vcs");
    Ok(())
}

/// Commit all pending changes with `message`; returns the new commit id.
#[tauri::command]
pub fn vcs_commit(
    app: AppHandle,
    state: State<'_, Shared>,
    message: String,
) -> Result<Option<String>, String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    let id = workspace.checkin(&message).map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "vcs");
    Ok(id)
}

/// Initialize a git repository for the workspace.
#[tauri::command]
pub fn vcs_init(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    state
        .workspace_mut()?
        .init_git()
        .map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "vcs");
    Ok(())
}

/// Revert one file to HEAD and reload the workspace.
#[tauri::command]
pub fn vcs_revert_file(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    if let Some(repo) = workspace.git() {
        repo.revert_file(&path).map_err(|err| err.to_string())?;
    }
    workspace
        .reload_disk_state()
        .map_err(|err| err.to_string())?;
    drop(state);
    changed_after_disk_change(&app);
    Ok(())
}

/// Current auto-check-in settings.
#[tauri::command]
pub fn autocheckin_get(state: State<'_, Shared>) -> Result<AutoCheckinInfo, String> {
    let state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace()?;
    Ok(AutoCheckinInfo {
        enabled: workspace.settings.auto_checkin,
        secs: workspace.settings.auto_checkin_secs,
    })
}

/// Enable or disable auto-check-in and set its idle delay in seconds.
#[tauri::command]
pub fn autocheckin_set(
    app: AppHandle,
    state: State<'_, Shared>,
    enabled: bool,
    secs: u64,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
    let workspace = state.workspace_mut()?;
    workspace.set_auto_checkin(enabled, secs);
    workspace.save_config().map_err(|err| err.to_string())?;
    drop(state);
    changed(&app, "vcs");
    Ok(())
}

/// Commit any pending auto-check-in when the idle debounce has elapsed.
#[tauri::command]
pub fn autocheckin_pump(
    app: AppHandle,
    state: State<'_, Shared>,
) -> Result<Option<String>, String> {
    let committed = {
        let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
        match state.workspace.as_mut() {
            Some(workspace) => workspace
                .pump_auto_checkin(Instant::now())
                .map_err(|err| err.to_string())?,
            None => None,
        }
    };
    if committed.is_some() {
        changed(&app, "vcs");
    }
    Ok(committed)
}
