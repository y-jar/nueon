//! Current window label and main-window flag.
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Label of the window this webview runs in (`main` or `tear-<id>`). */
export const windowLabel: string = getCurrentWindow().label;

/** Whether this is the primary application window. */
export const isMainWindow: boolean = windowLabel === "main";
