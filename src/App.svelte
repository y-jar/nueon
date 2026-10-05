<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./lib/api";
  import {
    ui,
    init,
    closeTab,
    openTranslation,
    activeGroup,
    activeDoc,
    refreshTable,
    type Activity,
  } from "./lib/state.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import ActivityBar from "./components/ActivityBar.svelte";
  import SidebarHost from "./components/SidebarHost.svelte";
  import TabBar from "./components/TabBar.svelte";
  import Editor from "./components/Editor.svelte";
  import Grid from "./components/Grid.svelte";
  import Translation from "./components/Translation.svelte";
  import Inspector from "./components/Inspector.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import EmptyState from "./components/EmptyState.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";

  const ACTIVITIES: Activity[] = ["notes", "dictionary", "translation", "git"];
  let layoutLoaded = $state(false);

  onMount(async () => {
    await init();
    try {
      const layout = await api.uiLayoutGet();
      ui.activity = ACTIVITIES.includes(layout.activity as Activity)
        ? (layout.activity as Activity)
        : "notes";
      ui.sidebarOpen = layout.sidebar_open;
      ui.inspectorOpen = layout.inspector_open;
      ui.inspectorDock = layout.inspector_dock === "left" ? "left" : "right";
    } catch {
      // Layout is best-effort.
    }
    // Restore the translation tool as a tab when it was the active activity.
    if (ui.activity === "translation") await openTranslation();
    layoutLoaded = true;
  });

  // Persist shell layout when it changes.
  $effect(() => {
    const snapshot = {
      activity: ui.activity,
      sidebar_open: ui.sidebarOpen,
      inspector_open: ui.inspectorOpen,
      inspector_dock: ui.inspectorDock,
    };
    if (!layoutLoaded || !ui.root) return;
    api.uiLayoutSet(snapshot).catch(() => {});
  });

  $effect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !ui.root) return;
      if (event.key === "z" && !event.shiftKey) {
        event.preventDefault();
        api.undo().catch(() => {});
      } else if ((event.key === "z" && event.shiftKey) || event.key === "y") {
        event.preventDefault();
        api.redo().catch(() => {});
      } else if (event.key === "w" && activeGroup().activeTabId) {
        event.preventDefault();
        closeTab(ui.activeGroupId, activeGroup().activeTabId!);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

{#if ui.root}
  <div
    class="shell"
    class:has-sidebar={ui.sidebarOpen}
    class:has-inspector={ui.inspectorOpen}
    class:dock-left={ui.inspectorDock === "left"}
  >
    <ActivityBar />
    {#if ui.sidebarOpen}
      <SidebarHost />
    {/if}
    <main class="center">
      <TabBar group={activeGroup()} />
      <div class="center-body">
        {#if activeGroup().tabs.length === 0}
          <EmptyState />
        {:else if activeDoc().view === "notes"}
          {#key activeGroup().id + (activeDoc().selected ?? "")}
            <Editor doc={activeDoc()} />
          {/key}
        {:else if activeDoc().view === "dictionary"}
          {#key activeGroup().id + (activeDoc().currentTable ?? "")}
            <Grid doc={activeDoc()} onRefresh={refreshTable} />
          {/key}
        {:else}
          <Translation />
        {/if}
      </div>
    </main>
    {#if ui.inspectorOpen}
      <Inspector />
    {/if}
    <footer class="statusbar">
      <span class="muted">{ui.status}</span>
      <span class="grow"></span>
      <span class="muted">{ui.root}</span>
    </footer>
  </div>
  <SettingsModal />
{:else}
  <Onboarding />
{/if}

<ContextMenu />
