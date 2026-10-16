//! Profile/workspace export and import: every path is chosen on the Rust
//! side (see docs/DECISIONS.md); these helpers run the dialog commands and
//! return what the backend reports, or null when cancelled.

import * as api from "./api";

/** Export the current conlang profile to a JSON file. */
export async function exportProfileDialog(): Promise<string | null> {
  try {
    return await api.profileExportDialog();
  } catch {
    return null;
  }
}

/** Zip the whole workspace (excluding `.git`) to a chosen file. */
export async function exportWorkspaceZipDialog(): Promise<string | null> {
  try {
    return await api.exportWorkspaceZipDialog();
  } catch {
    return null;
  }
}

/** Restore a workspace from a zip backup into a chosen parent directory. */
export async function importWorkspaceZipDialog(): Promise<string | null> {
  try {
    return await api.workspaceImportZipDialog();
  } catch {
    return null;
  }
}
