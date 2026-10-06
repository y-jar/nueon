//! Tauri command handlers.

mod assets;
mod dictionary;
mod export;
mod import;
mod notes;
mod translation;
mod trash;
mod vcs;
mod windows;
mod workspace;

pub use assets::*;
pub use dictionary::*;
pub use export::*;
pub use import::*;
pub use notes::*;
pub use translation::*;
pub use trash::*;
pub use vcs::*;
pub use windows::*;
pub use workspace::*;

use tauri::{AppHandle, Emitter};

/// Notify the frontend that data for `scope` changed so it can refetch.
pub(crate) fn changed(app: &AppHandle, scope: &str) {
    let _ = app.emit("data-changed", serde_json::json!({ "scope": scope }));
}
