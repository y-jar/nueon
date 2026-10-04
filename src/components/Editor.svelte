<script lang="ts">
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
        onDirty: (dirty: boolean) => (ui.dirty = dirty),
        onSave: api.saveNote,
      }}
    ></div>
  </div>
{:else}
  <div class="placeholder">Select a note, or create one from the sidebar.</div>
{/if}
