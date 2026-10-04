<script lang="ts">
  import * as api from "../lib/api";
  import type { WordIndex } from "../lib/api";
  import { ui } from "../lib/state.svelte";
  import { codemirror } from "../lib/editor/action";

  let index = $state<WordIndex>({});
  let loadedFor: string | null = null;

  // Load the dictionary word index once per open workspace.
  $effect(() => {
    const root = ui.root;
    if (root && loadedFor !== root) {
      loadedFor = root;
      api
        .wordIndex()
        .then((value) => (index = value))
        .catch(() => (index = {}));
    }
  });
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
        index,
        onDirty: (dirty: boolean) => (ui.dirty = dirty),
        onSave: api.saveNote,
      }}
    ></div>
  </div>
{:else}
  <div class="placeholder">Select a note, or create one from the sidebar.</div>
{/if}
