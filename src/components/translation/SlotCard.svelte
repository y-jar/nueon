<!-- One clause slot card. -->
<script lang="ts">
  import { X, GripVertical } from "@lucide/svelte";
  import { dragHandle } from "svelte-dnd-action";
  import type { ClauseSlot } from "../../lib/api";
  import type { SlotItem } from "./types";

  interface Props {
    item: SlotItem;
    tags: string[];
    classes: string[];
    separator: string;
    onUpdate: (slot: ClauseSlot) => void;
    onRemove: () => void;
  }

  let { item, tags, classes, separator, onUpdate, onRemove }: Props = $props();

  const classOptions = $derived(
    item.slot.kind === "pos" && !classes.includes(item.slot.class)
      ? [item.slot.class, ...classes]
      : classes,
  );
</script>

<div class="slot-card {item.slot.kind}">
  <span class="grip" use:dragHandle title="Drag to reorder">
    <GripVertical size={14} />
  </span>

  {#if item.slot.kind === "required_tag"}
    <span class="badge tag">#{item.slot.tag}</span>
    <select
      value={item.slot.tag}
      onpointerdown={(e) => e.stopPropagation()}
      onchange={(e) =>
        onUpdate({ kind: "required_tag", tag: e.currentTarget.value })}
    >
      {#each tags as name (name)}
        <option value={name}>{name}</option>
      {/each}
    </select>
  {:else if item.slot.kind === "pos"}
    <span class="badge tag">{item.slot.class}</span>
    <select
      value={item.slot.class}
      onpointerdown={(e) => e.stopPropagation()}
      onchange={(e) => onUpdate({ kind: "pos", class: e.currentTarget.value })}
    >
      {#each classOptions as name (name)}
        <option value={name}>{name}</option>
      {/each}
    </select>
  {:else if item.slot.kind === "literal"}
    <span class="badge">literal</span>
    <input
      class="slot-input"
      value={item.slot.text}
      onpointerdown={(e) => e.stopPropagation()}
      onblur={(e) => onUpdate({ kind: "literal", text: e.currentTarget.value })}
    />
  {:else if item.slot.kind === "wildcard"}
    <span class="badge wildcard">*</span>
    <span class="slot-text">wildcard</span>
  {:else}
    <span class="badge spacer">␣</span>
    <input
      class="slot-input spacer"
      value={item.slot.text ?? ""}
      placeholder={separator}
      onpointerdown={(e) => e.stopPropagation()}
      onblur={(e) =>
        onUpdate({
          kind: "spacer",
          text: e.currentTarget.value || null,
        })}
    />
  {/if}

  <button class="slot-remove" title="Remove" onclick={onRemove}>
    <X size={13} />
  </button>
</div>
