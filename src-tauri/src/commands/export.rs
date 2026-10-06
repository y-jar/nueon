//! Export the open note as ODT or PDF.
//!
//! ODT is built in `langloom-core`. PDF renders the note as styled HTML in a
//! hidden webview (so every script gets the system's font fallback and
//! shaping) and prints it to a file: silently through WebKitGTK on Linux, and
//! through the system print dialog elsewhere.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, State};

use langloom_core::export::{self, resolve_local};

use crate::state::AppState;

type Shared = Mutex<AppState>;

/// Output format.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Pdf,
    Odt,
}

impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Odt => "odt",
        }
    }
}

/// Export `markdown` (the editor's current text for `note_path`) to
/// `destination`. Returns a short status message.
#[tauri::command]
pub async fn export_document(
    app: AppHandle,
    state: State<'_, Shared>,
    format: ExportFormat,
    note_path: String,
    markdown: String,
    destination: String,
) -> Result<String, String> {
    let root = {
        let state = state.lock().map_err(|_| "state poisoned".to_string())?;
        state.workspace()?.root_path.clone()
    };

    let destination = PathBuf::from(destination);
    if !destination.is_absolute() {
        return Err("choose an absolute destination path".to_string());
    }
    let destination = destination.with_extension(format.extension());

    let note = Path::new(&note_path);
    let note_dir = root
        .join("notes")
        .join(note.parent().unwrap_or_else(|| Path::new("")));
    let title = note
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note".to_string());

    match format {
        ExportFormat::Odt => {
            let load = |src: &str| -> Option<(String, Vec<u8>)> {
                let path = resolve_local(&root, &note_dir, src)?;
                let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
                Some((extension, std::fs::read(path).ok()?))
            };
            let bytes =
                export::markdown_to_odt(&markdown, &title, &load).map_err(|err| err.to_string())?;
            std::fs::write(&destination, bytes).map_err(|err| err.to_string())?;
            Ok(format!("exported to {}", destination.display()))
        }
        ExportFormat::Pdf => {
            let rewrite = |src: &str| -> Option<String> {
                let path = resolve_local(&root, &note_dir, src)?;
                tauri::Url::from_file_path(path)
                    .ok()
                    .map(|url| url.to_string())
            };
            let body = export::markdown_to_html(&markdown, &rewrite);
            let document = export::html_document(&title, &body);

            let page = std::env::temp_dir().join(format!(
                "langloom-export-{}.html",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::write(&page, document).map_err(|err| err.to_string())?;

            let target = destination.clone();
            let source = page.clone();
            let printed =
                tauri::async_runtime::spawn_blocking(move || print_to_pdf(&app, &source, &target))
                    .await
                    .map_err(|err| err.to_string())?;
            let _ = std::fs::remove_file(&page);
            printed?;
            Ok(format!("exported to {}", destination.display()))
        }
    }
}

/// Load `page` in a hidden webview and print it to `destination` without a
/// dialog, using WebKitGTK's "Print to File".
#[cfg(target_os = "linux")]
fn print_to_pdf(app: &AppHandle, page: &Path, destination: &Path) -> Result<(), String> {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let url = tauri::Url::from_file_path(page).map_err(|_| "bad export path".to_string())?;
    let output = tauri::Url::from_file_path(destination)
        .map_err(|_| "bad destination path".to_string())?
        .to_string();

    let label = format!("export-{}", uuid::Uuid::new_v4().simple());
    let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("langloom export")
        .inner_size(900.0, 1200.0)
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = loaded_tx.send(());
            }
        })
        .build()
        .map_err(|err| err.to_string())?;

    let result = (|| -> Result<(), String> {
        loaded_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "timed out loading the document".to_string())?;

        let (done_tx, done_rx) = mpsc::channel::<Result<(), String>>();
        window
            .with_webview(move |webview| {
                let view = webview.inner();
                let operation = PrintOperation::new(&view);

                let settings = gtk::PrintSettings::new();
                settings.set_printer("Print to File");
                settings.set("output-file-format", Some("pdf"));
                settings.set("output-uri", Some(&output));
                operation.set_print_settings(&settings);

                let setup = gtk::PageSetup::new();
                setup.set_paper_size(&gtk::PaperSize::new(Some(gtk::PAPER_NAME_A4)));
                for set in [
                    gtk::PageSetup::set_top_margin,
                    gtk::PageSetup::set_bottom_margin,
                    gtk::PageSetup::set_left_margin,
                    gtk::PageSetup::set_right_margin,
                ] {
                    set(&setup, 18.0, gtk::Unit::Mm);
                }
                operation.set_page_setup(&setup);

                let finished = done_tx.clone();
                operation.connect_finished(move |_| {
                    let _ = finished.send(Ok(()));
                });
                let failed = done_tx;
                operation.connect_failed(move |_, error| {
                    let _ = failed.send(Err(error.to_string()));
                });
                operation.print();
            })
            .map_err(|err| err.to_string())?;

        done_rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| "timed out while printing".to_string())?
    })();

    let _ = window.destroy();
    result
}

/// Other platforms: open the document and let the user save it from the
/// system print dialog.
#[cfg(not(target_os = "linux"))]
fn print_to_pdf(app: &AppHandle, page: &Path, _destination: &Path) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let url = tauri::Url::from_file_path(page).map_err(|_| "bad export path".to_string())?;
    let label = format!("export-{}", uuid::Uuid::new_v4().simple());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("langloom export")
        .build()
        .map_err(|err| err.to_string())?;
    window
        .eval("window.addEventListener('load', () => window.print())")
        .map_err(|err| err.to_string())
}
