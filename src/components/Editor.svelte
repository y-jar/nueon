<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui, type DocState } from "../lib/state.svelte";
  import { codemirror } from "../lib/editor/action";
  import { stripMd } from "../lib/explorer";

  let { doc }: { doc: DocState } = $props();
</script>

{#if doc.selected}
  <div class="editor">
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
      }}
    ></div>
  </div>
{:else}
  <div class="placeholder">{$t("editor.selectNote")}</div>
{/if}
