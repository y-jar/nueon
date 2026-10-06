//! Secondary ("torn-off") window management.
//!
//! Every secondary window loads the same frontend as `main`, identifies
//! itself by its label (`tear-<id>`), and restores its own tiling from the
//! workspace layout, which `window_spawn` writes before the window exists.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use uuid::Uuid;

use nueon_core::{GroupLayout, SplitLayout, TabLayout, TilingLayout, WindowGeometry};

use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Default size (logical pixels) for a freshly torn-off window.
const DEFAULT_SIZE: (f64, f64) = (900.0, 700.0);

/// Labels of every window except `main`.
pub(crate) fn secondary_labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() != "main")
        .cloned()
        .collect()
}

/// Destroy windows. Callers must not hold the state lock: the resulting
/// `Destroyed` events lock it from the window event handler.
pub(crate) fn destroy_windows(app: &AppHandle, labels: &[String]) {
    for label in labels {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
}

/// Build the webview window for `label` and apply saved geometry.
///
/// Position/size are requests: Wayland compositors (notably tiling ones)
/// place windows themselves and may ignore them.
pub(crate) fn build_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    geometry: Option<WindowGeometry>,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(format!("nueon — {title}"))
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .build()
        .map_err(|err| err.to_string())?;

    if let Some(geometry) = geometry {
        let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
        if let (Some(x), Some(y)) = (geometry.x, geometry.y) {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    Ok(window)
}

fn single_tab_tiling(tab: TabLayout) -> TilingLayout {
    let group = Uuid::new_v4().to_string();
    TilingLayout {
        groups: vec![GroupLayout {
            id: group.clone(),
            tabs: vec![tab],
            active: Some(0),
        }],
        root: SplitLayout::Leaf {
            group: group.clone(),
        },
        active_group: Some(group),
    }
}

/// Open a new secondary window showing `tab`. Returns its label.
#[tauri::command]
pub async fn window_spawn(
    app: AppHandle,
    state: State<'_, Shared>,
    tab: TabLayout,
    geometry: Option<WindowGeometry>,
) -> Result<String, String> {
    let label = format!("tear-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let title = tab.title.clone();
    {
        let mut state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state
            .workspace_mut()?
            .set_window_tiling(&label, geometry, single_tab_tiling(tab))
            .map_err(|err| err.to_string())?;
    }
    build_window(&app, &label, &title, geometry)?;
    Ok(label)
}

/// Close the calling window (used when a secondary window runs out of tabs).
#[tauri::command]
pub fn window_close_self(window: WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        return Ok(());
    }
    window.destroy().map_err(|err| err.to_string())
}

/// Respawn every saved secondary window (called once per workspace open).
#[tauri::command]
pub async fn windows_restore(app: AppHandle, state: State<'_, Shared>) -> Result<usize, String> {
    let saved = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state.workspace()?.layout_state().windows
    };
    let mut spawned = 0;
    for window in saved {
        if app.get_webview_window(&window.label).is_some() {
            continue;
        }
        let title = window
            .tiling
            .groups
            .iter()
            .flat_map(|group| group.tabs.first())
            .map(|tab| tab.title.clone())
            .next()
            .unwrap_or_default();
        if build_window(&app, &window.label, &title, window.geometry).is_ok() {
            spawned += 1;
        }
    }
    Ok(spawned)
}
