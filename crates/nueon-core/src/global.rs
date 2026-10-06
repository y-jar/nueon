//! App-global configuration: the registry of known workspaces.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A registered workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    /// Display name; falls back to the folder name when empty.
    #[serde(default)]
    pub name: String,
    pub path: PathBuf,
}

/// Persisted window geometry and dock layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowLayout {
    /// Window width in physical pixels.
    pub width: u32,
    /// Window height in physical pixels.
    pub height: u32,
    /// Whether the source-control (git) pane was open.
    pub git_panel_open: bool,
}

impl Default for WindowLayout {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 800,
            git_panel_open: false,
        }
    }
}

/// The app-global configuration stored under `config.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlobalConfig {
    /// The most recently opened workspace.
    pub last: Option<PathBuf>,
    /// Known workspaces.
    pub workspaces: Vec<WorkspaceEntry>,
    /// Window geometry and dock layout.
    pub window: WindowLayout,
}

/// Result type for global configuration operations.
pub type GlobalResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

impl GlobalConfig {
    /// The default config path: `$XDG_CONFIG_HOME/nueon/config.toml`.
    pub fn config_path() -> Option<PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
        Some(base.join("nueon").join("config.toml"))
    }

    /// Load the default config, falling back to defaults on any error.
    pub fn load_default() -> Self {
        Self::config_path()
            .and_then(|path| Self::load_from(&path).ok())
            .unwrap_or_default()
    }

    /// Load from a specific path; a missing file yields defaults.
    pub fn load_from(path: &Path) -> GlobalResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = fs::read_to_string(path)?;
        Ok(toml::from_str(&text)?)
    }

    /// Save to the default config path.
    pub fn save(&self) -> GlobalResult<()> {
        let Some(path) = Self::config_path() else {
            return Ok(());
        };
        self.save_to(&path)
    }

    /// Save to a specific path, creating parent directories.
    pub fn save_to(&self, path: &Path) -> GlobalResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text = toml::to_string_pretty(self)?;
        fs::write(path, text)?;
        Ok(())
    }

    /// The display name for an entry.
    pub fn display_name(entry: &WorkspaceEntry) -> String {
        if !entry.name.trim().is_empty() {
            return entry.name.clone();
        }
        entry
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.path.display().to_string())
    }

    /// The active workspace, if any.
    pub fn active(&self) -> Option<&WorkspaceEntry> {
        self.last
            .as_deref()
            .and_then(|path| self.workspaces.iter().find(|entry| entry.path == path))
    }

    /// Register a workspace, keeping any existing name when `name` is empty.
    pub fn add(&mut self, path: impl Into<PathBuf>, name: impl Into<String>) {
        let path = path.into();
        let name = name.into();
        if let Some(existing) = self.workspaces.iter_mut().find(|entry| entry.path == path) {
            if existing.name.trim().is_empty() && !name.trim().is_empty() {
                existing.name = name;
            }
        } else {
            self.workspaces.push(WorkspaceEntry { name, path });
        }
    }

    /// Remove a workspace from the registry.
    pub fn remove(&mut self, path: &Path) {
        self.workspaces.retain(|entry| entry.path != path);
        if self.last.as_deref() == Some(path) {
            self.last = None;
        }
    }

    /// Rename a workspace's display name.
    pub fn rename(&mut self, path: &Path, name: impl Into<String>) {
        if let Some(entry) = self.workspaces.iter_mut().find(|entry| entry.path == path) {
            entry.name = name.into();
        }
    }

    /// Re-point a workspace to a new location.
    pub fn set_path(&mut self, from: &Path, to: impl Into<PathBuf>) {
        let to = to.into();
        if let Some(entry) = self.workspaces.iter_mut().find(|entry| entry.path == from) {
            entry.path = to.clone();
        }
        if self.last.as_deref() == Some(from) {
            self.last = Some(to);
        }
    }

    /// Record the current window size.
    pub fn set_window_size(&mut self, width: u32, height: u32) {
        self.window.width = width.max(1);
        self.window.height = height.max(1);
    }

    /// Record whether the git pane is open.
    pub fn set_git_panel_open(&mut self, open: bool) {
        self.window.git_panel_open = open;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let mut config = GlobalConfig::default();
        config.add("/a/one", "One");
        config.add("/b/two", "");
        config.last = Some(PathBuf::from("/a/one"));

        config.save_to(&path).unwrap();
        let loaded = GlobalConfig::load_from(&path).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(GlobalConfig::display_name(&loaded.workspaces[1]), "two");
    }

    #[test]
    fn missing_file_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = GlobalConfig::load_from(&dir.path().join("nope.toml")).unwrap();
        assert!(loaded.workspaces.is_empty());
    }

    #[test]
    fn add_rename_remove_and_repoint() {
        let mut config = GlobalConfig::default();
        config.add("/a/one", "");
        config.add("/a/one", "One");
        assert_eq!(config.workspaces[0].name, "One");

        config.rename(Path::new("/a/one"), "Uno");
        assert_eq!(config.workspaces[0].name, "Uno");

        config.last = Some(PathBuf::from("/a/one"));
        config.set_path(Path::new("/a/one"), PathBuf::from("/a/moved"));
        assert_eq!(config.workspaces[0].path, PathBuf::from("/a/moved"));
        assert_eq!(config.last, Some(PathBuf::from("/a/moved")));

        config.remove(Path::new("/a/moved"));
        assert!(config.workspaces.is_empty());
        assert!(config.last.is_none());
    }
}
