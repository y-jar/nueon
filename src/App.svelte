<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "./lib/api";
  import {
    ui,
    init,
    closeTab,
    openTranslation,
    activeGroup,
    serializeTiling,
    restoreMainTiling,
    restoreSecondaryTiling,
    installDragBridge,
    type Activity,
  } from "./lib/state.svelte";
  import { windowLabel, isMainWindow } from "./lib/window";
  import Onboarding from "./components/Onboarding.svelte";
  import ActivityBar from "./components/ActivityBar.svelte";
  import SidebarHost from "./components/SidebarHost.svelte";
  import SplitView from "./components/SplitView.svelte";
  import Inspector from "./components/Inspector.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";

  const ACTIVITIES: Activity[] = ["notes", "dictionary", "translation", "git"];
  let layoutLoaded = $state(false);

  onMount(async () => {
    await init();
    await installDragBridge();
    if (!isMainWindow) {
      // Torn-off windows show only tab groups; they restore their own tiling.
      await restoreSecondaryTiling(windowLabel);
      layoutLoaded = true;
      return;
    }
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
    await restoreMainTiling();
    // Restore the translation tool as a tab when it was the active activity.
    if (ui.activity === "translation") await openTranslation();
    layoutLoaded = true;
  });

  // A torn-off window with no tabs left has nothing to show: close it.
  $effect(() => {
    if (isMainWindow || !ui.layoutReady) return;
    if (ui.groups.every((group) => group.tabs.length === 0)) {
      api.windowCloseSelf().catch(() => {});
    }
  });

  // Persist this window's tab groups and splits (debounced).
  let savedTiling = "";
  let tilingTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (!ui.layoutReady || !ui.root) return;
    const tiling = serializeTiling();
    const json = JSON.stringify(tiling);
    if (json === savedTiling) return;
    if (tilingTimer) clearTimeout(tilingTimer);
    tilingTimer = setTimeout(() => {
      savedTiling = json;
      api.tilingSave(windowLabel, tiling).catch(() => {});
    }, 400);
  });

  // Persist shell layout when it changes.
  $effect(() => {
    const snapshot = {
      activity: ui.activity,
      sidebar_open: ui.sidebarOpen,
      inspector_open: ui.inspectorOpen,
      inspector_dock: ui.inspectorDock,
    };
    if (!isMainWindow || !layoutLoaded || !ui.root) return;
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

{#if ui.root && !isMainWindow}
  <div class="shell secondary">
    <main class="center">
      <SplitView node={ui.splitRoot} />
    </main>
  </div>
{:else if ui.root && !ui.showWorkspacePicker}
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
      <SplitView node={ui.splitRoot} />
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
