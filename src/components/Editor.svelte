<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";
  import { codemirror } from "../lib/editor/action";
</script>

{#if ui.selected}
  <div class="editor">
    <div class="editor-head">
      <span class="muted">{ui.selected}{ui.dirty ? " •" : ""}</span>
    </div>
    <div
      class="cm-host"
      use:codemirror={{
        path: ui.selected,
        content: ui.noteContent,
        index: ui.wordIndex,
        assetBase: ui.root ? `${ui.root}/notes` : "",
        onDirty: (dirty: boolean) => (ui.dirty = dirty),
        onSave: api.saveNote,
      }}
    ></div>
  </div>
{:else}
  <div class="placeholder">{$t("editor.selectNote")}</div>
{/if}
