//! Settings, grid views, shell/tiling layout and raw config access.

use super::*;

impl Workspace {
    /// Persist all configuration files.
    pub fn save_config(&mut self) -> Result<(), StorageError> {
        let dir = self.config_dir();
        storage::save_json(&dir.join(storage::LANGUAGE_FILE), &self.language)?;
        storage::save_json(&dir.join(storage::GRAMMAR_FILE), &self.grammar)?;
        storage::save_json(&dir.join(storage::TRANSLATION_FILE), &self.translation)?;
        storage::save_json(&dir.join(storage::PHONOLOGY_FILE), &self.phonology)?;
        storage::save_json(&dir.join(storage::SETTINGS_FILE), &self.settings)?;
        self.mark_change(Instant::now(), "nueon: update config");
        Ok(())
    }

    /// Persist the workspace settings file.
    pub fn save_settings(&mut self) -> Result<(), StorageError> {
        storage::save_json(
            &self.config_dir().join(storage::SETTINGS_FILE),
            &self.settings,
        )
    }

    /// The persisted grid presentation state for a table (default empty).
    pub fn grid_view(&self, table: &str) -> GridViewState {
        self.settings
            .grid_views
            .get(table)
            .cloned()
            .unwrap_or_default()
    }

    /// Persist the grid presentation state for a table.
    ///
    /// Presentation-only: does not schedule a content check-in.
    pub fn set_grid_view(&mut self, table: &str, view: GridViewState) -> Result<(), StorageError> {
        if view == GridViewState::default() {
            self.settings.grid_views.remove(table);
        } else {
            self.settings.grid_views.insert(table.to_string(), view);
        }
        self.save_settings()
    }

    /// The persisted shell layout.
    pub fn ui_layout(&self) -> UiLayout {
        self.settings.ui.clone()
    }

    /// Persist the shell layout (activity, panel visibility, inspector dock).
    pub fn set_ui_layout(&mut self, layout: UiLayout) -> Result<(), StorageError> {
        self.settings.ui = layout;
        self.save_settings()
    }

    /// The persisted tiling layout (main window + secondary windows).
    pub fn layout_state(&self) -> LayoutState {
        self.settings.layout.clone()
    }

    /// Persist the main window's tiling. Skips the write when unchanged.
    pub fn set_main_tiling(&mut self, tiling: TilingLayout) -> Result<(), StorageError> {
        if self.settings.layout.main.as_ref() == Some(&tiling) {
            return Ok(());
        }
        self.settings.layout.main = Some(tiling);
        self.save_settings()
    }

    /// Persist one secondary window's tiling (and geometry, when known).
    pub fn set_window_tiling(
        &mut self,
        label: &str,
        geometry: Option<WindowGeometry>,
        tiling: TilingLayout,
    ) -> Result<(), StorageError> {
        self.settings.layout.upsert_window(label, geometry, tiling);
        self.save_settings()
    }

    /// Record a secondary window's geometry. Returns whether anything changed.
    pub fn set_window_geometry(
        &mut self,
        label: &str,
        geometry: WindowGeometry,
    ) -> Result<bool, StorageError> {
        if !self.settings.layout.set_window_geometry(label, geometry) {
            return Ok(false);
        }
        self.save_settings()?;
        Ok(true)
    }

    /// Forget one secondary window.
    pub fn remove_window_layout(&mut self, label: &str) -> Result<(), StorageError> {
        if self.settings.layout.remove_window(label) {
            self.save_settings()?;
        }
        Ok(())
    }

    /// Read a config section (`language`, `grammar`, `translation`, `settings`)
    /// as JSON.
    pub fn config_json(&self, section: &str) -> Result<serde_json::Value, StorageError> {
        let value = match section {
            "language" => serde_json::to_value(&self.language),
            "grammar" => serde_json::to_value(&self.grammar),
            "translation" => serde_json::to_value(&self.translation),
            "phonology" => serde_json::to_value(&self.phonology),
            "settings" => serde_json::to_value(&self.settings),
            other => {
                return Err(StorageError::Config(
                    other.to_string(),
                    "unknown config section".to_string(),
                ))
            }
        };
        value.map_err(|err| StorageError::Config(section.to_string(), err.to_string()))
    }

    /// Replace a config section from JSON and persist it.
    pub fn set_config_json(
        &mut self,
        section: &str,
        value: serde_json::Value,
    ) -> Result<(), StorageError> {
        let dir = self.config_dir();
        let invalid =
            |err: serde_json::Error| StorageError::Config(section.to_string(), err.to_string());
        match section {
            "language" => {
                self.language = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::LANGUAGE_FILE), &self.language)?;
            }
            "grammar" => {
                self.grammar = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::GRAMMAR_FILE), &self.grammar)?;
            }
            "translation" => {
                self.translation = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::TRANSLATION_FILE), &self.translation)?;
            }
            "phonology" => {
                self.phonology = serde_json::from_value(value).map_err(invalid)?;
                storage::save_json(&dir.join(storage::PHONOLOGY_FILE), &self.phonology)?;
            }
            // The settings file also holds grid views, layout and migration
            // flags. Replacing it wholesale from the UI could wipe all of that,
            // so it is only ever changed through the dedicated methods.
            "settings" => {
                return Err(StorageError::Config(
                    "settings".to_string(),
                    "the settings file cannot be replaced wholesale".to_string(),
                ))
            }
            other => {
                return Err(StorageError::Config(
                    other.to_string(),
                    "unknown config section".to_string(),
                ))
            }
        }
        self.mark_change(Instant::now(), format!("nueon: update {section} config"));
        Ok(())
    }
}
