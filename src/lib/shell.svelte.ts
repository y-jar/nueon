//! Shell chrome: the activity ribbon, panels and modal toggles.

import { ui, type Activity } from "./store.svelte";
import { openMorphology, openPhonology, openTranslation } from "./state.svelte";

export function setActivity(activity: Activity): void {
  ui.activity = activity;
  ui.sidebarOpen = true;
  if (activity === "translation") openTranslation();
  if (activity === "morphology") openMorphology();
  if (activity === "phonology") openPhonology();
}

export function toggleSidebar(): void {
  ui.sidebarOpen = !ui.sidebarOpen;
}

export function toggleInspector(): void {
  ui.inspectorOpen = !ui.inspectorOpen;
}

export function setInspectorDock(side: "left" | "right"): void {
  ui.inspectorDock = side;
}

/** Open the import wizard. */
export function openImport(): void {
  ui.importOpen = true;
}

/** Close the import wizard. */
export function closeImport(): void {
  ui.importOpen = false;
}

export function openSettings(): void {
  ui.settingsOpen = true;
}

export function closeSettings(): void {
  ui.settingsOpen = false;
}

export function openSetupWizard(): void {
  ui.setupWizardOpen = true;
}

export function closeSetupWizard(): void {
  ui.setupWizardOpen = false;
}
