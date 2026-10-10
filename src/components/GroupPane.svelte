<!-- One split pane: tab bar, body, drop edges. -->
<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import GroupBody from "./GroupBody.svelte";
  import {
    ui,
    setActiveGroup,
    splitGroup,
    moveTab,
    endTabDrag,
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
  let overBody = $state(false);

  // Drop-zone highlights vanish whenever a drag ends or is cancelled.
  $effect(() => {
    if (!ui.dragTab) {
      edge = null;
      overBody = false;
    }
  });

  function accept(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function onEdgeOver(event: DragEvent, side: Edge) {
    if (!ui.dragTab) return;
    accept(event);
    event.stopPropagation();
    edge = side;
    overBody = true;
  }

  function onEdgeDrop(event: DragEvent, side: Edge) {
    event.preventDefault();
    event.stopPropagation();
    const drag = ui.dragTab;
    endTabDrag();
    if (drag) void splitGroup(drag.fromGroupId, drag.tabId, groupId, side);
  }

  function onBodyOver(event: DragEvent) {
    if (!ui.dragTab) return;
    accept(event);
    overBody = true;
  }

  function onBodyLeave(event: DragEvent) {
    const next = event.relatedTarget as Node | null;
    if (!(event.currentTarget as HTMLElement).contains(next)) {
      overBody = false;
      edge = null;
    }
  }

  function onBodyDrop(event: DragEvent) {
    const drag = ui.dragTab;
    if (!drag) return;
    event.preventDefault();
    endTabDrag();
    // Dropping a tab back onto its own pane is a no-op.
    if (drag.fromGroupId === groupId) return;
    void moveTab(drag.tabId, drag.fromGroupId, groupId, null);
  }
</script>

<div
  class="group-pane"
  class:active={ui.activeGroupId === groupId}
  role="group"
  onpointerdown={() => setActiveGroup(groupId)}
  onfocusin={() => setActiveGroup(groupId)}
>
  <TabBar group={findGroup()} />
  <div
    class="center-body"
    role="presentation"
    ondragover={onBodyOver}
    ondragleave={onBodyLeave}
    ondrop={onBodyDrop}
  >
    <GroupBody group={findGroup()} {groupId} />

    {#if ui.dragTab}
      {#if overBody && edge === null && ui.dragTab.fromGroupId !== groupId}
        <div class="drop-merge" aria-hidden="true"></div>
      {/if}
      {#each EDGES as side (side)}
        <div
          class="edge edge-{side}"
          class:hot={edge === side}
          role="presentation"
          ondragover={(e) => onEdgeOver(e, side)}
          ondrop={(e) => onEdgeDrop(e, side)}
        ></div>
      {/each}
    {/if}
  </div>
</div>
