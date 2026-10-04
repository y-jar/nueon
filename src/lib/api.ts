import { invoke } from "@tauri-apps/api/core";

/** A registered workspace (mirrors `langloom_core::WorkspaceEntry`). */
export interface WorkspaceEntry {
  name: string;
  path: string;
}

export const ping = (): Promise<string> => invoke("ping");

export const workspaceList = (): Promise<WorkspaceEntry[]> =>
  invoke("workspace_list");

export const workspaceCurrent = (): Promise<string | null> =>
  invoke("workspace_current");
