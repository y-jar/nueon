//! Version-control integration, backed by the system `git` CLI.

pub mod autocheckin;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub use autocheckin::AutoCheckin;

/// Errors raised by the version-control layer.
#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("git is not installed or not on PATH")]
    GitNotInstalled,
    #[error("not a git repository: {0}")]
    NotARepo(PathBuf),
    #[error("git command failed: {command}: {stderr}")]
    Command { command: String, stderr: String },
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
}

/// Whether `git` can be executed at all.
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The detected version-control state of a workspace.
#[derive(Debug)]
pub enum GitStatus {
    /// Git is installed and the directory is a repository.
    Ready(GitRepo),
    /// Git is installed, but the directory is not a repository.
    NotARepo,
    /// Git is not installed.
    GitNotInstalled,
}

impl GitStatus {
    /// Inspect `root` and report its version-control state.
    pub fn detect(root: &Path) -> Self {
        if !git_available() {
            return GitStatus::GitNotInstalled;
        }
        if GitRepo::is_repo(root) {
            match GitRepo::open(root) {
                Ok(repo) => GitStatus::Ready(repo),
                Err(_) => GitStatus::NotARepo,
            }
        } else {
            GitStatus::NotARepo
        }
    }

    /// The repository, if one is ready.
    pub fn repo(&self) -> Option<&GitRepo> {
        match self {
            GitStatus::Ready(repo) => Some(repo),
            _ => None,
        }
    }

    /// Whether a repository is ready.
    pub fn is_ready(&self) -> bool {
        self.repo().is_some()
    }
}

/// A single line of `git status` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// The two-character porcelain status code, e.g. ` M` or `??`.
    pub code: String,
    /// Path relative to the repository root.
    pub path: PathBuf,
}

/// A single commit from the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub id: String,
    pub author: String,
    pub date: String,
    pub summary: String,
}

/// A handle to a git repository rooted at a workspace directory.
#[derive(Debug, Clone)]
pub struct GitRepo {
    root: PathBuf,
}

impl GitRepo {
    /// Whether `root` already contains a `.git` directory.
    pub fn is_repo(root: &Path) -> bool {
        root.join(".git").exists()
    }

    /// Open an existing repository.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, VcsError> {
        let root = root.into();
        if !Self::is_repo(&root) {
            return Err(VcsError::NotARepo(root));
        }
        Ok(Self { root })
    }

    /// Initialize a repository and create the first commit.
    ///
    /// A repository-local fallback author identity is configured when none is
    /// present, so check-ins work in environments without a global git config.
    pub fn init(root: impl Into<PathBuf>) -> Result<Self, VcsError> {
        let root = root.into();
        if !git_available() {
            return Err(VcsError::GitNotInstalled);
        }
        std::fs::create_dir_all(&root)?;

        if !Self::is_repo(&root) {
            let out = Self::raw(&root, &["init", "-b", "main"])?;
            if !out.status.success() {
                return Err(VcsError::Command {
                    command: "git init -b main".into(),
                    stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                });
            }
        }

        let repo = Self { root };
        repo.ensure_identity()?;
        repo.commit_all("langloom: initialize workspace")?;
        Ok(repo)
    }

    /// The repository root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn raw(root: &Path, args: &[&str]) -> Result<std::process::Output, VcsError> {
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    VcsError::GitNotInstalled
                } else {
                    VcsError::Io(e)
                }
            })
    }

    fn git(&self, args: &[&str]) -> Result<std::process::Output, VcsError> {
        Self::raw(&self.root, args)
    }

    fn checked(&self, args: &[&str]) -> Result<String, VcsError> {
        let out = self.git(args)?;
        if !out.status.success() {
            return Err(VcsError::Command {
                command: format!("git {}", args.join(" ")),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    fn ensure_identity(&self) -> Result<(), VcsError> {
        let email = self.git(&["config", "user.email"])?;
        if String::from_utf8_lossy(&email.stdout).trim().is_empty() {
            self.checked(&["config", "user.name", "langloom"])?;
            self.checked(&["config", "user.email", "langloom@localhost"])?;
        }
        Ok(())
    }

    /// Working-tree status, parsed from porcelain output.
    pub fn status(&self) -> Result<Vec<StatusEntry>, VcsError> {
        let out = self.checked(&["status", "--porcelain=v1", "-z"])?;
        let mut entries = Vec::new();
        for chunk in out.split('\0') {
            if chunk.len() < 3 {
                continue;
            }
            let code = chunk[..2].to_string();
            let path = PathBuf::from(&chunk[3..]);
            entries.push(StatusEntry { code, path });
        }
        Ok(entries)
    }

    /// Whether the working tree is clean.
    pub fn is_clean(&self) -> Result<bool, VcsError> {
        Ok(self.status()?.is_empty())
    }

    fn has_staged_changes(&self) -> Result<bool, VcsError> {
        let out = self.git(&["diff", "--cached", "--quiet"])?;
        Ok(out.status.code() == Some(1))
    }

    /// Stage every change and commit. Returns the commit id, or `None` when
    /// there was nothing to commit.
    pub fn commit_all(&self, message: &str) -> Result<Option<String>, VcsError> {
        self.checked(&["add", "-A"])?;
        if !self.has_staged_changes()? {
            return Ok(None);
        }
        self.checked(&["commit", "-m", message])?;
        let id = self.checked(&["rev-parse", "HEAD"])?.trim().to_string();
        Ok(Some(id))
    }

    /// The most recent `limit` commits, newest first.
    pub fn log(&self, limit: usize) -> Result<Vec<Commit>, VcsError> {
        let pretty = "--pretty=format:%H%x1f%an%x1f%ad%x1f%s";
        let count = format!("-n{}", limit.max(1));
        let out = self.checked(&["log", count.as_str(), "--date=iso-strict", pretty])?;

        let mut commits = Vec::new();
        for line in out.lines() {
            let mut parts = line.split('\u{1f}');
            let id = parts.next().unwrap_or_default().to_string();
            let author = parts.next().unwrap_or_default().to_string();
            let date = parts.next().unwrap_or_default().to_string();
            let summary = parts.next().unwrap_or_default().to_string();
            if !id.is_empty() {
                commits.push(Commit {
                    id,
                    author,
                    date,
                    summary,
                });
            }
        }
        Ok(commits)
    }

    /// A short diffstat of the working tree.
    pub fn diff_stat(&self) -> Result<String, VcsError> {
        self.checked(&["diff", "--stat"])
    }

    /// Show a single commit.
    pub fn show(&self, id: &str) -> Result<String, VcsError> {
        self.checked(&["show", id])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_reports_not_a_repo_for_plain_dir() {
        let dir = tempfile::tempdir().unwrap();
        if !git_available() {
            return;
        }
        assert!(matches!(GitStatus::detect(dir.path()), GitStatus::NotARepo));
    }

    #[test]
    fn init_commit_and_log() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes"), "hello").unwrap();

        let repo = GitRepo::init(dir.path()).unwrap();
        assert!(GitRepo::is_repo(dir.path()));
        assert!(repo.is_clean().unwrap());

        let commits = repo.log(10).unwrap();
        assert_eq!(commits.len(), 1);
        assert!(commits[0].summary.contains("initialize"));

        // No changes => no new commit.
        assert_eq!(repo.commit_all("noop").unwrap(), None);

        std::fs::write(dir.path().join("more"), "world").unwrap();
        assert!(!repo.is_clean().unwrap());
        let id = repo.commit_all("langloom: test change").unwrap();
        assert!(id.is_some());

        let commits = repo.log(10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].summary, "langloom: test change");
        assert!(repo.is_clean().unwrap());
    }

    #[test]
    fn status_reports_untracked_and_modified() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let repo = GitRepo::init(dir.path()).unwrap();

        std::fs::write(dir.path().join("words"), "a").unwrap();
        let status = repo.status().unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].path, PathBuf::from("words"));

        repo.commit_all("add words").unwrap();
        std::fs::write(dir.path().join("words"), "b").unwrap();
        let status = repo.status().unwrap();
        assert_eq!(status.len(), 1);
        assert!(status[0].code.contains('M'));
    }
}
