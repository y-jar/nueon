<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui, openEditorContextMenu, type DocState } from "../lib/state.svelte";
  import type { EditorView } from "@codemirror/view";
  import EditorToolbar from "./EditorToolbar.svelte";
  import {
    EMPTY_FORMAT,
    insertImageMarkdown,
    type FormatState,
  } from "../lib/editor/commands";
  import { codemirror } from "../lib/editor/action";
  import { open } from "@tauri-apps/plugin-dialog";
  import { assetLink, linkLabel } from "../lib/assets";
  import { stripMd } from "../lib/explorer";

  let { doc }: { doc: DocState } = $props();

  let view = $state<EditorView | null>(null);
  let format = $state<FormatState>({ ...EMPTY_FORMAT });

  /** Pick an image, import it to `assets/`, and reference it from the note. */
  async function insertImage() {
    const target = view;
    const note = doc.selected;
    if (!target || !note) return;
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"],
          },
        ],
      });
      if (typeof picked !== "string") return;
      const asset = await api.importAsset(picked);
      insertImageMarkdown(
        target,
        linkLabel(asset.original_name),
        assetLink(note, asset.name),
      );
      target.focus();
    } catch (error) {
      ui.status = `could not insert image: ${String(error)}`;
    }
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
        data-note={doc.selected}
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
