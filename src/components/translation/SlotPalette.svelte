<script lang="ts">
  import { t } from "svelte-i18n";
  import type { ClauseSlot } from "../../lib/api";

  interface Props {
    tags: string[];
    onAddTag: (name: string) => void;
    onAddPrimitive: (slot: ClauseSlot) => void;
  }

  let { tags, onAddTag, onAddPrimitive }: Props = $props();

  const DRAG_TYPE = "application/x-nueon-slot";

  function dragStart(event: DragEvent, slot: ClauseSlot) {
    const payload = JSON.stringify(slot);
    event.dataTransfer?.setData(DRAG_TYPE, payload);
    event.dataTransfer?.setData("text/plain", payload);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  }
</script>

<div class="palette-row">
  <div class="palette-group">
    <span class="palette-label">{$t("translation.tags")}</span>
    {#each tags as name (name)}
      <button
        class="palette-chip tag"
        draggable="true"
        ondragstart={(e) => dragStart(e, { kind: "required_tag", tag: name })}
        onclick={() => onAddTag(name)}>#{name}</button
      >
    {/each}
  </div>

  <div class="palette-group">
    <span class="palette-label">{$t("translation.primitives")}</span>
    <button
      class="palette-chip"
      draggable="true"
      ondragstart={(e) => dragStart(e, { kind: "literal", text: "ka" })}
      onclick={() => onAddPrimitive({ kind: "literal", text: "ka" })}
      >{$t("translation.literal")}</button
    >
    <button
      class="palette-chip"
      draggable="true"
      ondragstart={(e) => dragStart(e, { kind: "wildcard" })}
      onclick={() => onAddPrimitive({ kind: "wildcard" })}
      >{$t("translation.wildcard")}</button
    >
    <button
      class="palette-chip"
      draggable="true"
      ondragstart={(e) => dragStart(e, { kind: "spacer", text: null })}
      onclick={() => onAddPrimitive({ kind: "spacer" })}
      >{$t("translation.spacer")}</button
    >
  </div>
</div>
