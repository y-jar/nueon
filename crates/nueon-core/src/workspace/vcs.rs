//! Git check-ins and the automatic check-in pump.

use super::*;

impl Workspace {
    // -- check-ins ------------------------------------------------------

    /// Commit all pending changes immediately with an explicit message.
    pub fn checkin(&mut self, message: &str) -> Result<Option<String>, VcsError> {
        self.auto.cancel();
        self.force_checkin(message)
    }

    /// Commit pending changes when the application is closing.
    pub fn close_checkin(&mut self) -> Result<Option<String>, VcsError> {
        self.auto.cancel();
        self.force_checkin("nueon: session check-in")
    }

    /// Persist the "don't show the git prompt again" preference.
    pub fn set_git_prompt_dismissed(&mut self, dismissed: bool) -> Result<(), StorageError> {
        self.settings.git_prompt_dismissed = dismissed;
        self.save_settings()
    }

    /// Whether a one-time warning has been silenced.
    pub fn is_warning_dismissed(&self, key: &str) -> bool {
        self.settings
            .dismissed_warnings
            .iter()
            .any(|item| item == key)
    }

    /// Silence a one-time warning and persist the preference.
    pub fn dismiss_warning(&mut self, key: &str) -> Result<(), StorageError> {
        if !self.is_warning_dismissed(key) {
            self.settings.dismissed_warnings.push(key.to_string());
        }
        self.save_settings()
    }

    /// Confirm-dialog kinds the user asked not to see again.
    pub fn suppressed_confirms(&self) -> Vec<String> {
        self.settings.suppressed_confirms.clone()
    }

    /// Whether a confirm kind has been silenced.
    pub fn is_confirm_suppressed(&self, kind: &str) -> bool {
        self.settings
            .suppressed_confirms
            .iter()
            .any(|item| item == kind)
    }

    /// Silence a confirm kind and persist the preference.
    pub fn suppress_confirm(&mut self, kind: &str) -> Result<(), StorageError> {
        if !self.is_confirm_suppressed(kind) {
            self.settings.suppressed_confirms.push(kind.to_string());
        }
        self.save_settings()
    }

    /// Un-silence one confirm kind, or every kind when `kind` is `None`.
    pub fn unsuppress_confirm(&mut self, kind: Option<&str>) -> Result<(), StorageError> {
        match kind {
            Some(kind) => self
                .settings
                .suppressed_confirms
                .retain(|item| item != kind),
            None => self.settings.suppressed_confirms.clear(),
        }
        self.save_settings()
    }

    /// Whether the Markdown editor shows line numbers.
    pub fn editor_line_numbers(&self) -> bool {
        self.settings.editor_line_numbers
    }

    /// Persist the editor's line-number preference.
    pub fn set_editor_line_numbers(&mut self, show: bool) -> Result<(), StorageError> {
        self.settings.editor_line_numbers = show;
        self.save_settings()
    }

    /// Commit the pending auto-check-in if the workspace has been idle long
    /// enough. Intended to be called from the UI event loop.
    pub fn pump_auto_checkin(&mut self, now: Instant) -> Result<Option<String>, VcsError> {
        if !self.auto.due(now) {
            return Ok(None);
        }
        let Some(message) = self.auto.take() else {
            return Ok(None);
        };
        let Some(repo) = self.vcs.repo() else {
            return Ok(None);
        };
        repo.commit_all(&message)
    }

    pub(crate) fn mark_change(&mut self, now: Instant, message: impl Into<String>) {
        if self.settings.auto_checkin && self.vcs.is_ready() {
            self.auto.mark(now, message);
        }
    }

    pub(crate) fn force_checkin(&mut self, message: &str) -> Result<Option<String>, VcsError> {
        match self.vcs.repo() {
            Some(repo) => repo.commit_all(message),
            None => Ok(None),
        }
    }
}
