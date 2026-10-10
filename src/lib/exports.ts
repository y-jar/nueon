/**
 * Export dialogs shared by Settings and the notes sidebar. Each opens a save
 * dialog and, if a destination is chosen, runs the matching backend command.
 * Returns the chosen path, or `null` when cancelled.
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import * as api from "./api";

/** Export the current conlang profile to a JSON file. */
export async function exportProfileDialog(): Promise<string | null> {
  const path = await save({
    defaultPath: "profile.nueon.json",
    filters: [{ name: "Nueon profile", extensions: ["json"] }],
  });
  if (!path) return null;
  await api.profileExport(path);
  return path;
}

/** Zip the whole workspace (excluding `.git`) to a chosen file. */
export async function exportWorkspaceZipDialog(): Promise<string | null> {
  const path = await save({
    defaultPath: "workspace.zip",
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (!path) return null;
  await api.exportWorkspaceZip(path);
  return path;
}

/** Restore a workspace from a zip backup into a chosen parent directory. */
export async function importWorkspaceZipDialog(): Promise<string | null> {
  const zipPath = await open({
    multiple: false,
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (typeof zipPath !== "string") return null;
  const parent = await open({ directory: true, multiple: false });
  if (typeof parent !== "string") return null;
  const base = (zipPath.split("/").pop() ?? "restored").replace(/\.zip$/, "");
  const dest = `${parent.replace(/\/$/, "")}/${base}`;
  return api.workspaceImportZip(zipPath, dest);
}
