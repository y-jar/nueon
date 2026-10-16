<!-- Vector toolbar: undo/redo, zoom, snap, compose and SVG import/export. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { readTextFile, writeTextFile } from "../lib/files";
  import {
    editor,
    exportFont,
    exportGlyphSvg,
    importSvg,
    redo,
    fitGlyph,
    zoomActual,
    zoomStep,
    toggleCompose,
    toggleSnap,
    undo,
  } from "../lib/writingEditor.svelte";

  async function exportSvg() {
    const svg = await exportGlyphSvg();
    if (svg === null) return;
    const path = await saveDialog({
      defaultPath: `${editor.glyphMeta?.name ?? "glyph"}.svg`,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!path) return;
    try {
      await writeTextFile(path, svg);
      editor.status = `exported ${path}`;
    } catch (e) {
      editor.error = String(e);
    }
  }

  async function exportFontFile() {
    const path = await saveDialog({
      defaultPath: "script.ttf",
      filters: [{ name: "TrueType font", extensions: ["ttf"] }],
    });
    if (!path) return;
    await exportFont(path);
  }

  async function importFile() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (typeof path !== "string") return;
    try {
      await importSvg(await readTextFile(path));
    } catch (e) {
      editor.error = String(e);
    }
  }
</script>

<div class="vector-toolbar">
  <button disabled={!editor.canUndo} title={$t("writing.toolbarHints.undo")} onclick={undo}>Undo</button>
  <button disabled={!editor.canRedo} title={$t("writing.toolbarHints.redo")} onclick={redo}>Redo</button>
  <div class="toolbar-group">
    <button title="Zoom out" onclick={() => zoomStep(1 / Math.SQRT2)}>-</button>
    <span class="mono" data-testid="zoom-percent">{Math.round(editor.zoom * 100)}%</span>
    <button title="Zoom in" onclick={() => zoomStep(Math.SQRT2)}>+</button>
    <button title="Fit glyph (0)" onclick={fitGlyph}>Fit</button>
    <button title="100% (1)" onclick={zoomActual}>100%</button>
  </div>
  <button class:active={editor.snap} title={$t("writing.toolbarHints.snap")} onclick={toggleSnap}>Snap</button>
  <button
    class:active={editor.composeOpen}
    title={$t("writing.toolbarHints.compose")}
    onclick={toggleCompose}
  >
    {$t("writing.compose")}
  </button>
  <span class="grow"></span>
  <button title={$t("writing.toolbarHints.exportFont")} onclick={() => void exportFontFile()}>{$t("writing.exportFont")}</button>
  <button title={$t("writing.toolbarHints.exportSvg")} onclick={() => void exportSvg()}>{$t("writing.exportSvg")}</button>
  <button title={$t("writing.toolbarHints.importSvg")} onclick={() => void importFile()}>{$t("writing.importSvg")}</button>
</div>
