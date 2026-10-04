use std::path::PathBuf;

use langloom::{app, GitStatus, Workspace};

/// Default workspace directory, following the XDG base directory spec.
fn default_workspace() -> PathBuf {
    if let Some(dir) = std::env::var_os("LANGLOOM_WORKSPACE") {
        return PathBuf::from(dir);
    }

    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));

    base.join("langloom")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut root: Option<PathBuf> = None;
    let mut check_only = false;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--check" => check_only = true,
            _ => root = Some(PathBuf::from(arg)),
        }
    }
    let root = root.unwrap_or_else(default_workspace);

    if check_only {
        let workspace = Workspace::load(root)?;
        print_summary(&workspace);
        return Ok(());
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("langloom")
            .with_inner_size([1280.0, 800.0]),
        ..Default::default()
    };

    eframe::run_native(
        "langloom",
        options,
        Box::new(move |cc: &eframe::CreationContext<'_>| {
            app::theme::apply(&cc.egui_ctx);
            let workspace = Workspace::load(&root)?;
            Ok(Box::new(app::LangloomApp::new(workspace)) as Box<dyn eframe::App>)
        }),
    )?;

    Ok(())
}

fn print_summary(workspace: &Workspace) {
    println!("langloom workspace: {}", workspace.root_path.display());
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
}
