<!-- Vector toolbar: zoom, snap, compose and export/import stubs. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { editor, setZoom, toggleSnap, toggleCompose } from "../lib/writingEditor.svelte";

  function stub(label: string) {
    editor.status = `${label} (stub)`;
  }
</script>

<div class="editor-toolbar">
  <div class="toolbar-group">
    <button onclick={() => setZoom(Math.max(0.25, editor.zoom - 0.25))}>-</button>
    <span class="mono">{Math.round(editor.zoom * 100)}%</span>
    <button onclick={() => setZoom(Math.min(4, editor.zoom + 0.25))}>+</button>
    <button onclick={() => setZoom(1)}>Fit</button>
  </div>
  <button class:active={editor.snap} onclick={toggleSnap}>Snap</button>
  <button class:active={editor.composeOpen} onclick={toggleCompose}>
    {$t("writing.compose")}
  </button>
  <span class="grow"></span>
  <button onclick={() => stub("Export")}>Export</button>
  <button onclick={() => stub("Import")}>Import</button>
</div>
