<script lang="ts">
  import { t } from "svelte-i18n";
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
    moveTab,
    toggleInspector,
    toggleSidebar,
    setInspectorDock,
    type Tab,
    type TabGroup,
  } from "../lib/state.svelte";

  let { group }: { group: TabGroup } = $props();

  function onDragStart(event: DragEvent, tab: Tab) {
    ui.dragTab = { tabId: tab.id, fromGroupId: group.id };
    event.dataTransfer?.setData("text/plain", tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragEnd() {
    ui.dragTab = null;
  }

  function onTabOver(event: DragEvent) {
    if (!ui.dragTab) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onTabDrop(event: DragEvent, beforeTab: Tab) {
    const drag = ui.dragTab;
    event.preventDefault();
    event.stopPropagation();
    if (!drag) return;
    ui.dragTab = null;
    moveTab(drag.tabId, drag.fromGroupId, group.id, beforeTab.id);
  }

  function onStripDrop(event: DragEvent) {
    const drag = ui.dragTab;
    if (!drag) return;
    event.preventDefault();
    ui.dragTab = null;
    moveTab(drag.tabId, drag.fromGroupId, group.id, null);
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
    role="tablist"
    tabindex="0"
    ondragover={(e) => {
      if (ui.dragTab) e.preventDefault();
    }}
    ondrop={onStripDrop}
  >
    {#each group.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === group.activeTabId}
        class:dragging={ui.dragTab?.tabId === tab.id}
        role="tab"
        tabindex="0"
        draggable="true"
        ondragstart={(e) => onDragStart(e, tab)}
        ondragend={onDragEnd}
        ondragover={onTabOver}
        ondrop={(e) => onTabDrop(e, tab)}
      >
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
