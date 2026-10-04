<script lang="ts">
  import { ui } from "../lib/state.svelte";
</script>

<aside class="inspector">
  <div class="pane-title">Inspector</div>
  {#if ui.selected}
    <p class="muted">note: {ui.selected}</p>
  {:else}
    <p class="muted">Select a word or note.</p>
  {/if}
</aside>
