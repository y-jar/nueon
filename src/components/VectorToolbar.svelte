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
    setZoom,
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
  <button disabled={!editor.canUndo} onclick={undo}>Undo</button>
  <button disabled={!editor.canRedo} onclick={redo}>Redo</button>
  <div class="toolbar-group">
    <button onclick={() => setZoom(editor.zoom - 0.25)}>-</button>
    <span class="mono">{Math.round(editor.zoom * 100)}%</span>
    <button onclick={() => setZoom(editor.zoom + 0.25)}>+</button>
    <button onclick={() => setZoom(1)}>Fit</button>
  </div>
  <button class:active={editor.snap} onclick={toggleSnap}>Snap</button>
  <button class:active={editor.composeOpen} onclick={toggleCompose}>
    {$t("writing.compose")}
  </button>
  <span class="grow"></span>
  <button onclick={() => void exportFontFile()}>{$t("writing.exportFont")}</button>
  <button onclick={() => void exportSvg()}>{$t("writing.exportSvg")}</button>
  <button onclick={() => void importFile()}>{$t("writing.importSvg")}</button>
</div>
