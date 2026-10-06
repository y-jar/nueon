<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui, openEditorContextMenu, type DocState } from "../lib/state.svelte";
  import type { EditorView } from "@codemirror/view";
  import EditorToolbar from "./EditorToolbar.svelte";
  import {
    EMPTY_FORMAT,
    insertImageTemplate,
    type FormatState,
  } from "../lib/editor/commands";
  import { codemirror } from "../lib/editor/action";
  import { stripMd } from "../lib/explorer";

  let { doc }: { doc: DocState } = $props();

  let view = $state<EditorView | null>(null);
  let format = $state<FormatState>({ ...EMPTY_FORMAT });

  function insertImage() {
    if (!view) return;
    insertImageTemplate(view);
    view.focus();
  }
</script>

{#if doc.selected}
  <div class="editor">
    <EditorToolbar {view} {format} onImage={insertImage} />
    <div class="editor-inner">
      <div class="editor-head">
        <span class="muted">{stripMd(doc.selected)}{doc.dirty ? " •" : ""}</span>
      </div>
      <div
        class="cm-host"
        use:codemirror={{
          path: doc.selected,
          content: doc.noteContent,
          index: ui.wordIndex,
          assetBase: ui.root ? `${ui.root}/notes` : "",
          onDirty: (dirty: boolean) => (doc.dirty = dirty),
          onSave: api.saveNote,
          onView: (next: EditorView | null) => (view = next),
          onFormat: (next: FormatState) => (format = next),
          onContextMenu: openEditorContextMenu,
        }}
      ></div>
    </div>
  </div>
{:else}
  <div class="placeholder">{$t("editor.selectNote")}</div>
{/if}
