<script lang="ts">
  import { t } from "svelte-i18n";
  import { dndzone } from "svelte-dnd-action";
  import {
    FileText,
    Table2,
    Languages,
    X,
    PanelRight,
    PanelLeft,
  } from "@lucide/svelte";
  import {
    ui,
    activateTab,
    closeTab,
    reorderTabs,
    toggleInspector,
    toggleSidebar,
    setInspectorDock,
    type Tab,
    type TabGroup,
  } from "../lib/state.svelte";

  let { group }: { group: TabGroup } = $props();

  function handleDnd(event: CustomEvent<{ items: Tab[] }>) {
    reorderTabs(group.id, event.detail.items);
  }

  function onAuxClick(event: MouseEvent, id: string) {
    if (event.button === 1) {
      event.preventDefault();
      closeTab(group.id, id);
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
    use:dndzone={{ items: group.tabs, flipDurationMs: 120 }}
    onconsider={handleDnd}
    onfinalize={handleDnd}
  >
    {#each group.tabs as tab (tab.id)}
      <div class="tab" class:active={tab.id === group.activeTabId}>
        <button
          class="tab-label"
          onclick={() => activateTab(group.id, tab.id)}
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
          {#if tab.kind === "note" &&
            group.doc.selected === tab.ref &&
            group.doc.dirty}
            <span class="tab-dot">•</span>
          {/if}
        </button>
        <button
          class="tab-close"
          title={$t("tabs.close")}
          onclick={(e) => {
            e.stopPropagation();
            closeTab(group.id, tab.id);
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
