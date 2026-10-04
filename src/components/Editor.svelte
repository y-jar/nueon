<script lang="ts">
  import { ui, markDirty, saveCurrent } from "../lib/state.svelte";

  function onKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrent();
    }
  }
</script>

{#if ui.selected}
  <div class="editor">
    <div class="editor-head">
      <span class="muted">{ui.selected}{ui.dirty ? " •" : ""}</span>
      <button onclick={saveCurrent} disabled={!ui.dirty}>Save</button>
    </div>
    <textarea
      class="editor-body"
      spellcheck="false"
      bind:value={ui.content}
      oninput={markDirty}
      onkeydown={onKeydown}
      onblur={() => ui.dirty && saveCurrent()}
    ></textarea>
    <p class="muted note">
      Plain-text fallback editor — CodeMirror 6 Live Preview lands in R3.
    </p>
  </div>
{:else}
  <div class="placeholder">Select a note, or create one from the sidebar.</div>
{/if}
