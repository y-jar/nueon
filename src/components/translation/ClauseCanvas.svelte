<!-- Drag-and-drop clause construction grid. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { dragHandleZone } from "svelte-dnd-action";
  import type { ClauseSlot } from "../../lib/api";
  import SlotCard from "./SlotCard.svelte";
  import { SLOT_DRAG_TYPE, type SlotItem } from "./types";

  interface Props {
    items: SlotItem[];
    tags: string[];
    classes: string[];
    separator: string;
    onReorder: (items: SlotItem[]) => void;
    onUpdate: (id: string, slot: ClauseSlot) => void;
    onRemove: (id: string) => void;
    onDropSlot: (slot: ClauseSlot) => void;
  }

  let {
    items,
    tags,
    classes,
    separator,
    onReorder,
    onUpdate,
    onRemove,
    onDropSlot,
  }: Props = $props();

  let dragOver = $state(false);

  function handleDnd(event: CustomEvent<{ items: SlotItem[] }>) {
    onReorder([...event.detail.items]);
  }

  function isSlotDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes(SLOT_DRAG_TYPE);
  }

  function onDragOver(event: DragEvent) {
    if (!isSlotDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  function onDrop(event: DragEvent) {
    const raw = event.dataTransfer?.getData(SLOT_DRAG_TYPE);
    dragOver = false;
    if (!raw) return;
    event.preventDefault();
    try {
      onDropSlot(JSON.parse(raw) as ClauseSlot);
    } catch {
      // Ignore malformed payloads.
    }
  }
</script>

<div
  class="clause-canvas"
  class:drop-active={dragOver}
  role="list"
  aria-label={$t("translation.dropHint")}
  use:dragHandleZone={{ items, type: "clause", flipDurationMs: 120 }}
  onconsider={handleDnd}
  onfinalize={handleDnd}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#each items as item (item.id)}
    <SlotCard
      {item}
      {tags}
      {classes}
      {separator}
      onUpdate={(slot) => onUpdate(item.id, slot)}
      onRemove={() => onRemove(item.id)}
    />
  {/each}

  {#if items.length === 0}
    <p class="muted">{$t("translation.dropHint")}</p>
  {/if}
</div>
