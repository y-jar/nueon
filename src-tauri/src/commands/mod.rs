//! Tauri command handlers.

mod dictionary;
mod notes;
mod translation;
mod workspace;

pub use dictionary::*;
pub use notes::*;
pub use translation::*;
pub use workspace::*;

use tauri::{AppHandle, Emitter};

/// Notify the frontend that data for `scope` changed so it can refetch.
pub(crate) fn changed(app: &AppHandle, scope: &str) {
    let _ = app.emit("data-changed", serde_json::json!({ "scope": scope }));
}
