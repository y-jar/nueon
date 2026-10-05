<script lang="ts">
  import { onMount } from "svelte";
  import { ui, init, setView, toggleGitPanel } from "./lib/state.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Editor from "./components/Editor.svelte";
  import Grid from "./components/Grid.svelte";
  import Translation from "./components/Translation.svelte";
  import Inspector from "./components/Inspector.svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";

  onMount(() => {
    init();
  });
</script>

{#if ui.root}
  <div class="shell">
    <header class="topbar">
      <span class="brand">langloom</span>
      <button
        class:active={ui.gitPanelOpen}
        onclick={toggleGitPanel}>Source Control</button
      >
      <span class="muted">{ui.status}</span>
    </header>
    <Sidebar />
    <main class="center">
      <div class="tabs">
        <button class:active={ui.view === "notes"} onclick={() => setView("notes")}
          >Notes</button
        >
        <button
          class:active={ui.view === "dictionary"}
          onclick={() => setView("dictionary")}>Dictionary</button
        >
        <button
          class:active={ui.view === "translation"}
          onclick={() => setView("translation")}>Translation</button
        >
      </div>
      {#if ui.view === "notes"}
        <Editor />
      {:else if ui.view === "dictionary"}
        <Grid />
      {:else}
        <Translation />
      {/if}
    </main>
    {#if ui.gitPanelOpen}
      <GitPanel />
    {:else}
      <Inspector />
    {/if}
  </div>
{:else}
  <Onboarding />
{/if}

<ContextMenu />
