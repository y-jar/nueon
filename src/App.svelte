<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "./lib/api";
  import { ui, init, setView, toggleGitPanel } from "./lib/state.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import Editor from "./components/Editor.svelte";
  import Grid from "./components/Grid.svelte";
  import Translation from "./components/Translation.svelte";
  import Inspector from "./components/Inspector.svelte";
  import GitPanel from "./components/GitPanel.svelte";
  import Settings from "./components/Settings.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";

  onMount(async () => {
    await init();
    try {
      const layout = await api.layoutGet();
      ui.gitPanelOpen = layout.git_panel_open;
    } catch {
      // Layout persistence is best-effort.
    }
  });

  $effect(() => {
    api.layoutSetGitPanel(ui.gitPanelOpen).catch(() => {});
  });

  $effect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !ui.root) return;
      if (event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        api.undo().catch(() => {});
      } else if (
        (event.key === "z" && event.shiftKey) ||
        event.key === "y"
      ) {
        event.preventDefault();
        api.redo().catch(() => {});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

{#if ui.root}
  <div class="shell">
    <header class="topbar">
      <span class="brand">{$t("app.brand")}</span>
      <button class:active={ui.gitPanelOpen} onclick={toggleGitPanel}
        >{$t("git.sourceControl")}</button
      >
      <span class="muted">{ui.status}</span>
    </header>
    <Sidebar />
    <main class="center">
      <div class="tabs">
        <button class:active={ui.view === "notes"} onclick={() => setView("notes")}
          >{$t("tabs.notes")}</button
        >
        <button
          class:active={ui.view === "dictionary"}
          onclick={() => setView("dictionary")}>{$t("tabs.dictionary")}</button
        >
        <button
          class:active={ui.view === "translation"}
          onclick={() => setView("translation")}>{$t("tabs.translation")}</button
        >
        <button
          class:active={ui.view === "settings"}
          onclick={() => setView("settings")}>{$t("tabs.settings")}</button
        >
      </div>
      {#if ui.view === "notes"}
        <Editor />
      {:else if ui.view === "dictionary"}
        <Grid />
      {:else if ui.view === "translation"}
        <Translation />
      {:else}
        <Settings />
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
