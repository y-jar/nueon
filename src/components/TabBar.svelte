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
    beginTabDrag,
    endTabDrag,
    toggleInspector,
    toggleSidebar,
    setInspectorDock,
    type Tab,
    type TabGroup,
  } from "../lib/state.svelte";

  let { group }: { group: TabGroup } = $props();

  let marker = $state<{ id: string; after: boolean } | null>(null);

  function onDragStart(event: DragEvent, tab: Tab) {
    event.dataTransfer?.setData("text/plain", tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    beginTabDrag(tab.id, group.id);
  }

  function onDragEnd() {
    marker = null;
    endTabDrag();
  }

  function onTabOver(event: DragEvent, tab: Tab) {
    if (!ui.dragTab) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    marker = { id: tab.id, after: event.clientX > rect.left + rect.width / 2 };
  }

  function onTabDrop(event: DragEvent, tab: Tab) {
    const drag = ui.dragTab;
    const after = marker?.after ?? false;
    event.preventDefault();
    event.stopPropagation();
    marker = null;
    endTabDrag();
    if (!drag) return;
    const index = group.tabs.findIndex((candidate) => candidate.id === tab.id);
    const before = after ? (group.tabs[index + 1]?.id ?? null) : tab.id;
    void moveTab(drag.tabId, drag.fromGroupId, group.id, before);
  }

  function onStripDrop(event: DragEvent) {
    const drag = ui.dragTab;
    if (!drag) return;
    event.preventDefault();
    marker = null;
    endTabDrag();
    void moveTab(drag.tabId, drag.fromGroupId, group.id, null);
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
      if (!ui.dragTab) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    }}
    ondragleave={(e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
        marker = null;
    }}
    ondrop={onStripDrop}
  >
    {#each group.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === group.activeTabId}
        class:dragging={ui.dragTab?.tabId === tab.id}
        class:drop-before={marker?.id === tab.id && !marker.after}
        class:drop-after={marker?.id === tab.id && marker.after}
        role="tab"
        tabindex="0"
        draggable="true"
        ondragstart={(e) => onDragStart(e, tab)}
        ondragend={onDragEnd}
        ondragover={(e) => onTabOver(e, tab)}
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
