//! Idle-debounced automatic check-in scheduler.
//!
//! Saves are written to disk immediately; this scheduler only decides when it
//! is safe to batch the accumulated changes into a single git commit. Each new
//! change resets the timer, so a commit happens once the workspace has been
//! idle for the configured debounce.

use std::time::{Duration, Instant};

/// How many pending messages the commit subject spells out before counting
/// the rest as "+N more changes". The full list is kept in the commit body.
const SUMMARY_LIMIT: usize = 3;

/// Tracks pending changes and when they should be committed.
#[derive(Debug, Clone)]
pub struct AutoCheckin {
    enabled: bool,
    debounce: Duration,
    last_change: Option<Instant>,
    pending: Vec<String>,
}

impl AutoCheckin {
    /// Create a scheduler with the given enabled flag and debounce window.
    pub fn new(enabled: bool, debounce: Duration) -> Self {
        Self {
            enabled,
            debounce,
            last_change: None,
            pending: Vec::new(),
        }
    }

    /// Whether automatic check-in is enabled.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Enable or disable automatic check-in.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// The idle debounce window.
    pub fn debounce(&self) -> Duration {
        self.debounce
    }

    /// Set the idle debounce window.
    pub fn set_debounce(&mut self, debounce: Duration) {
        self.debounce = debounce;
    }

    /// Whether there are uncommitted pending changes.
    pub fn is_dirty(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Record a change, resetting the idle timer.
    pub fn mark(&mut self, now: Instant, message: impl Into<String>) {
        let message = message.into();
        self.last_change = Some(now);
        if !message.is_empty() {
            self.pending.push(message);
        }
    }

    /// Whether a check-in is due at `now`.
    pub fn due(&self, now: Instant) -> bool {
        if !self.enabled || !self.is_dirty() {
            return false;
        }
        match self.last_change {
            Some(changed_at) => now.saturating_duration_since(changed_at) >= self.debounce,
            None => true,
        }
    }

    /// Drain the pending check-in message, if one is due to be committed.
    ///
    /// The subject line stays readable: past [`SUMMARY_LIMIT`] changes it
    /// summarizes and counts the rest, while the full list travels in the
    /// commit body.
    pub fn take(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            self.last_change = None;
            return None;
        }
        let messages = std::mem::take(&mut self.pending);
        self.last_change = None;
        if messages.len() <= SUMMARY_LIMIT {
            return Some(messages.join("; "));
        }
        let subject = format!(
            "{}; +{} more changes",
            messages[..SUMMARY_LIMIT].join("; "),
            messages.len() - SUMMARY_LIMIT
        );
        Some(format!("{subject}\n\n{}", messages.join("\n")))
    }

    /// Discard pending changes.
    pub fn cancel(&mut self) {
        self.pending.clear();
        self.last_change = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_dirty_until_marked() {
        let mut auto = AutoCheckin::new(true, Duration::from_secs(60));
        let now = Instant::now();
        assert!(!auto.is_dirty());
        assert!(!auto.due(now));

        auto.mark(now, "change");
        assert!(auto.is_dirty());
        assert!(!auto.due(now));
    }

    #[test]
    fn due_after_idle_debounce() {
        let mut auto = AutoCheckin::new(true, Duration::from_secs(60));
        let start = Instant::now();
        auto.mark(start, "first");
        assert!(!auto.due(start + Duration::from_secs(59)));
        assert!(auto.due(start + Duration::from_secs(60)));
        assert_eq!(auto.take().unwrap(), "first");
        assert!(!auto.is_dirty());
    }

    #[test]
    fn new_change_resets_the_timer() {
        let mut auto = AutoCheckin::new(true, Duration::from_secs(60));
        let start = Instant::now();
        auto.mark(start, "first");
        auto.mark(start + Duration::from_secs(30), "second");

        // 60s after the first change is not yet due: the second reset it.
        assert!(!auto.due(start + Duration::from_secs(60)));
        assert!(auto.due(start + Duration::from_secs(90)));
        assert_eq!(auto.take().unwrap(), "first; second");
    }

    #[test]
    fn a_long_batch_is_summarized_with_the_full_list_in_the_body() {
        let mut auto = AutoCheckin::new(true, Duration::ZERO);
        let now = Instant::now();
        for name in ["one", "two", "three", "four", "five"] {
            auto.mark(now, name);
        }
        let message = auto.take().unwrap();
        let (subject, body) = message.split_once("\n\n").expect("body separated");
        assert_eq!(subject, "one; two; three; +2 more changes");
        assert_eq!(body, "one\ntwo\nthree\nfour\nfive");
    }

    #[test]
    fn disabled_never_due() {
        let mut auto = AutoCheckin::new(false, Duration::ZERO);
        auto.mark(Instant::now(), "change");
        assert!(!auto.due(Instant::now()));
    }
}
