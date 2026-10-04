use std::path::PathBuf;

use anyhow::Result;
use langjar::{GitStatus, Workspace};

/// Default workspace directory, following the XDG base directory spec.
fn default_workspace() -> PathBuf {
    if let Some(dir) = std::env::var_os("LANGJAR_WORKSPACE") {
        return PathBuf::from(dir);
    }

    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));

    base.join("langjar")
}

fn main() -> Result<()> {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_workspace);

    let workspace = Workspace::load(root)?;

    println!("langjar workspace: {}", workspace.root_path.display());
    println!("tables: {}", workspace.dictionary.tables.len());
    for table in workspace.dictionary.tables() {
        println!(
            "  - {} ({} words, {} tags)",
            table.name,
            table.entries.len(),
            table.tags.len()
        );
    }
    println!("notes: {}", workspace.notes.len());

    match &workspace.vcs {
        GitStatus::Ready(_) => println!("git: ready"),
        GitStatus::NotARepo => {
            println!("git: not a repository (the app will prompt to initialize)")
        }
        GitStatus::GitNotInstalled => {
            println!("git: not installed (the app will prompt to install)")
        }
    }

    Ok(())
}
