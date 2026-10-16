<!-- Vector toolbar: undo/redo, zoom, snap, compose and SVG import/export. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import {
    editor,
    exportFont,
    importSvgDialog,
    redo,
    fitGlyph,
    zoomActual,
    zoomStep,
    toggleCompose,
    toggleSnap,
    undo,
  } from "../lib/writingEditor.svelte";

  async function exportSvg() {
    if (!editor.openGlyphId) return;
    try {
      const path = await api.writingExportSvgDialog(editor.openGlyphId);
      editor.status = `exported ${path}`;
    } catch (e) {
      if (String(e).includes("cancelled")) return;
      editor.error = String(e);
    }
  }

  async function exportFontFile() {
    await exportFont();
  }

  async function importFile() {
    await importSvgDialog();
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
