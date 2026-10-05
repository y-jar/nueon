<script lang="ts">
  import { t } from "svelte-i18n";
  import { dndzone } from "svelte-dnd-action";
  import { FileText, Table2, Languages, X, PanelRight, PanelLeft } from "@lucide/svelte";
  import {
    ui,
    activateTab,
    closeTab,
    reorderTabs,
    toggleInspector,
    toggleSidebar,
    setInspectorDock,
    type Tab,
  } from "../lib/state.svelte";

  function handleDnd(event: CustomEvent<{ items: Tab[] }>) {
    reorderTabs(event.detail.items);
  }

  function onAuxClick(event: MouseEvent, id: string) {
    if (event.button === 1) {
      event.preventDefault();
      closeTab(id);
    }
  }
</script>

<div class="tabbar">
  <button
    class="tab-action"
    title={$t("activity.toggleSidebar")}
    onclick={toggleSidebar}
  >
    <PanelLeft size={16} />
  </button>

  <div
    class="tab-strip"
    use:dndzone={{ items: ui.tabs, flipDurationMs: 120 }}
    onconsider={handleDnd}
    onfinalize={handleDnd}
  >
    {#each ui.tabs as tab (tab.id)}
      <div class="tab" class:active={tab.id === ui.activeTabId}>
        <button
          class="tab-label"
          onclick={() => activateTab(tab.id)}
          onauxclick={(e) => onAuxClick(e, tab.id)}
        >
          {#if tab.kind === "note"}
            <FileText size={13} />
          {:else if tab.kind === "table"}
            <Table2 size={13} />
          {:else}
            <Languages size={13} />
          {/if}
          <span class="tab-title">{tab.title}</span>
          {#if tab.kind === "note" && ui.selected === tab.ref && ui.dirty}
            <span class="tab-dot">•</span>
          {/if}
        </button>
        <button
          class="tab-close"
          title={$t("tabs.close")}
          onclick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
        >
          <X size={12} />
        </button>
      </div>
    {/each}
  </div>

  <button
    class="tab-action"
    class:active={ui.inspectorOpen}
    title={$t("inspector.toggle")}
    onclick={toggleInspector}
    oncontextmenu={(e) => {
      e.preventDefault();
      setInspectorDock(ui.inspectorDock === "left" ? "right" : "left");
    }}
  >
    <PanelRight size={16} />
  </button>
</div>
