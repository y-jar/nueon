//! Per-workspace application settings.

use serde::{Deserialize, Serialize};

/// Default auto-check-in interval, in seconds.
pub const DEFAULT_AUTO_CHECKIN_SECS: u64 = 60;

/// User preferences stored in `config/settings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    /// Whether to automatically check changes into git.
    pub auto_checkin: bool,
    /// Idle debounce before an automatic check-in, in seconds.
    pub auto_checkin_secs: u64,
    /// Table to open by default, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_table: Option<String>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            auto_checkin: true,
            auto_checkin_secs: DEFAULT_AUTO_CHECKIN_SECS,
            default_table: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_apply() {
        let settings: WorkspaceSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.auto_checkin);
        assert_eq!(settings.auto_checkin_secs, DEFAULT_AUTO_CHECKIN_SECS);
    }
}
