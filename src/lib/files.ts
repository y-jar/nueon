//! Whole-file text read/write through the Tauri backend (for SVG import/export).
import { invoke } from "@tauri-apps/api/core";

export const readTextFile = (path: string): Promise<string> =>
  invoke("read_text_file", { path });

export const writeTextFile = (path: string, text: string): Promise<void> =>
  invoke("write_text_file", { path, text });
