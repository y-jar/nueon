<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import GroupBody from "./GroupBody.svelte";
  import {
    ui,
    setActiveGroup,
    splitGroup,
    moveTab,
    type TabGroup,
  } from "../lib/state.svelte";

  let { groupId }: { groupId: string } = $props();

  type Edge = "left" | "right" | "top" | "bottom";
  const EDGES: Edge[] = ["left", "right", "top", "bottom"];

  function findGroup(): TabGroup {
    return (
      ui.groups.find((candidate) => candidate.id === groupId) ?? ui.groups[0]
    );
  }

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
  <TabBar group={findGroup()} />
  <div class="center-body">
    <GroupBody group={findGroup()} {groupId} />
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
