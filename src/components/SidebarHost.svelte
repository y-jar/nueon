<!-- Host showing the active activity's sidebar. -->
<script lang="ts">
  import { ui } from "../lib/state.svelte";
  import Sidebar from "./Sidebar.svelte";
  import TablesPanel from "./TablesPanel.svelte";
  import MorphologyPanel from "./MorphologyPanel.svelte";
  import GitPanel from "./GitPanel.svelte";
</script>

{#if ui.activity === "notes"}
  <Sidebar />
{:else if ui.activity === "dictionary"}
  <TablesPanel />
{:else if ui.activity === "morphology"}
  <MorphologyPanel />
{:else if ui.activity === "git"}
  <GitPanel />
{:else}
  <aside class="sidebar">
    <p class="muted">—</p>
  </aside>
{/if}
