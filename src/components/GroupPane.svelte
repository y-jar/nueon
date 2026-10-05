<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import Editor from "./Editor.svelte";
  import Grid from "./Grid.svelte";
  import Translation from "./Translation.svelte";
  import EmptyState from "./EmptyState.svelte";
  import {
    ui,
    setActiveGroup,
    reloadGroupTable,
    splitGroup,
    moveTab,
  } from "../lib/state.svelte";

  let { groupId }: { groupId: string } = $props();

  type Edge = "left" | "right" | "top" | "bottom";
  const EDGES: Edge[] = ["left", "right", "top", "bottom"];

  const group = $derived(
    ui.groups.find((candidate) => candidate.id === groupId) ?? ui.groups[0],
  );
  let edge = $state<Edge | null>(null);

  function onEdgeOver(event: DragEvent, side: Edge) {
    if (!ui.dragTab) return;
    event.preventDefault();
    event.stopPropagation();
    edge = side;
  }

  function onEdgeDrop(event: DragEvent, side: Edge) {
    event.preventDefault();
    event.stopPropagation();
    const drag = ui.dragTab;
    edge = null;
    ui.dragTab = null;
    if (drag) splitGroup(drag.fromGroupId, drag.tabId, groupId, side);
  }

  function onBodyDrop(event: DragEvent) {
    const drag = ui.dragTab;
    if (!drag) return;
    event.preventDefault();
    ui.dragTab = null;
    moveTab(drag.tabId, drag.fromGroupId, groupId, null);
  }
</script>

<div
  class="group-pane"
  class:active={ui.activeGroupId === groupId}
  role="group"
  onpointerdown={() => setActiveGroup(groupId)}
  ondragover={(e) => {
    if (ui.dragTab) e.preventDefault();
  }}
  ondrop={onBodyDrop}
>
  <TabBar {group} />
  <div class="center-body">
    {#if group.tabs.length === 0}
      <EmptyState />
    {:else if group.doc.view === "notes"}
      {#key group.id + (group.doc.selected ?? "")}
        <Editor doc={group.doc} />
      {/key}
    {:else if group.doc.view === "dictionary"}
      {#key group.id + (group.doc.currentTable ?? "")}
        <Grid doc={group.doc} onRefresh={() => reloadGroupTable(group.id)} />
      {/key}
    {:else}
      <Translation />
    {/if}
  </div>

  {#if ui.dragTab}
    {#each EDGES as side (side)}
      <div
        class="edge edge-{side}"
        class:hot={edge === side}
        role="presentation"
        ondragover={(e) => onEdgeOver(e, side)}
        ondragleave={() => {
          if (edge === side) edge = null;
        }}
        ondrop={(e) => onEdgeDrop(e, side)}
      ></div>
    {/each}
  {/if}
</div>
