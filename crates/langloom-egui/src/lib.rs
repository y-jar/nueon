//! Legacy egui UI for langloom.
//!
//! Temporary reference implementation kept while the app migrates to
//! Tauri + Svelte. It will be removed once the Tauri UI reaches feature parity.

pub mod app;

// Re-export the core so the UI's `crate::model`, `crate::workspace`, ... paths
// keep resolving unchanged after the workspace split.
pub use langloom_core::*;
