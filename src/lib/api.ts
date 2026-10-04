import { invoke } from "@tauri-apps/api/core";

/** A registered workspace (mirrors `langloom_core::WorkspaceEntry`). */
export interface WorkspaceEntry {
  name: string;
  path: string;
}

/** A node in the notes tree (mirrors `langloom_tauri`'s `NoteNode`). */
export interface NoteNode {
  name: string;
  /** Path relative to `notes/`, using `/` separators. */
  path: string;
  is_dir: boolean;
  children: NoteNode[];
}

/** A dictionary entry matching a spelling (mirrors `langloom_core::WordHit`). */
export interface WordHit {
  id: string;
  table: string;
  wordname: string;
  senses: string[];
  tags: string[];
}

/** Lowercased wordname → matching entries. */
export type WordIndex = Record<string, WordHit[]>;

export const ping = (): Promise<string> => invoke("ping");

// -- workspace registry --------------------------------------------------
export const workspaceList = (): Promise<WorkspaceEntry[]> =>
  invoke("workspace_list");
export const workspaceCurrent = (): Promise<string | null> =>
  invoke("workspace_current");
export const workspaceOpen = (path: string): Promise<string> =>
  invoke("workspace_open", { path });
export const workspaceCreate = (
  name: string,
  destination: string,
): Promise<string> => invoke("workspace_create", { name, destination });
export const workspaceRemove = (path: string): Promise<void> =>
  invoke("workspace_remove", { path });
export const workspaceRename = (path: string, name: string): Promise<void> =>
  invoke("workspace_rename", { path, name });
export const workspaceSetPath = (from: string, to: string): Promise<void> =>
  invoke("workspace_set_path", { from, to });
export const workspaceDeleteFromDisk = (path: string): Promise<void> =>
  invoke("workspace_delete_from_disk", { path });

// -- notes ---------------------------------------------------------------
export const listWorkspace = (): Promise<NoteNode[]> =>
  invoke("list_workspace");
export const readNote = (relPath: string): Promise<string> =>
  invoke("read_note", { relPath });
export const saveNote = (relPath: string, content: string): Promise<void> =>
  invoke("save_note", { relPath, content });
export const createNote = (relPath: string): Promise<void> =>
  invoke("create_note", { relPath });
export const createFolder = (relPath: string): Promise<void> =>
  invoke("create_folder", { relPath });
export const moveOrRenameNote = (
  oldPath: string,
  newPath: string,
): Promise<void> => invoke("move_or_rename_note", { oldPath, newPath });
export const deleteNote = (relPath: string): Promise<void> =>
  invoke("delete_note", { relPath });

// -- dictionary ----------------------------------------------------------
export const wordIndex = (): Promise<WordIndex> => invoke("word_index");
