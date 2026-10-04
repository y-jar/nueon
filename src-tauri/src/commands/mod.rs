//! Tauri command handlers.

mod notes;
mod workspace;

pub use notes::*;
pub use workspace::*;

use tauri::{AppHandle, Emitter};

/// Notify the frontend that data for `scope` changed so it can refetch.
pub(crate) fn changed(app: &AppHandle, scope: &str) {
    let _ = app.emit("data-changed", serde_json::json!({ "scope": scope }));
}
