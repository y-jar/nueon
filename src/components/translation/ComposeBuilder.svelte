<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowLeft, ArrowRight, Save, Trash2, X } from "@lucide/svelte";
  import { ui } from "../../lib/state.svelte";
  import {
    PIECE_DRAG_TYPE,
    morphology as store,
  } from "../../lib/morphology.svelte";

  let definition = $state("");
  let saveTable = $state("");
  let saved = $state(false);

  const morphemeTables = $derived(
    new Set(store.morphemes.map((morpheme) => morpheme.table)),
  );
  const tables = $derived(
    ui.tables
      .filter((table) => !morphemeTables.has(table.name))
      .map((table) => table.name),
  );

  function onDragOver(event: DragEvent) {
    if (Array.from(event.dataTransfer?.types ?? []).includes(PIECE_DRAG_TYPE)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  }

  function onDrop(event: DragEvent) {
    const raw = event.dataTransfer?.getData(PIECE_DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    const { kind, id } = JSON.parse(raw) as {
      kind: "word" | "morpheme";
      id: string;
    };
    store.addPieceRef(kind, id);
    saved = false;
  }

  async function save() {
    if (!saveTable || !store.composed) return;
    const id = await store.saveComposed(saveTable, definition.trim());
    if (id) {
      saved = true;
      definition = "";
      ui.status = $t("morphology.savedStatus", {
        values: { word: store.composed.surface },
      });
    }
  }
</script>

<div class="compose-builder">
  <div
    class="compose-strip"
    ondragover={onDragOver}
    ondrop={onDrop}
    role="list"
  >
    {#each store.pieces as piece (piece.key)}
      <span class="compose-chip {piece.kind}">
        <button
          class="chip-move"
          title={$t("morphology.moveLeft")}
          onclick={() => store.moveChip(piece.key, -1)}><ArrowLeft size={11} /></button
        >
        <span class="mono">{piece.label}</span>
        <span class="muted">{piece.gloss}</span>
        <button
          class="chip-move"
          title={$t("morphology.moveRight")}
          onclick={() => store.moveChip(piece.key, 1)}><ArrowRight size={11} /></button
        >
        <button
          class="chip-remove"
          title={$t("morphology.removeRule")}
          onclick={() => store.removeChip(piece.key)}><X size={11} /></button
        >
      </span>
    {:else}
      <span class="muted">{$t("morphology.composeHint")}</span>
    {/each}
  </div>

  {#if store.pieces.length}
    <button class="clear-strip" onclick={() => store.clearStrip()}>
      <Trash2 size={13} /> {$t("morphology.clear")}
    </button>
  {/if}

  {#if store.composed}
    <div class="inflect-surface">{store.composed.surface}</div>
    <div class="inflect-pieces">
      {#each store.composed.morphemes as morpheme, index (index)}
        <span class="piece {morpheme.kind}">
          <span class="mono">{morpheme.surface}</span>
          <span class="muted">{morpheme.gloss}</span>
        </span>
      {/each}
    </div>

    <div class="compose-save">
      <select bind:value={saveTable}>
        <option value="">{$t("morphology.table")}</option>
        {#each tables as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      <input
        class="grow"
        placeholder={$t("morphology.definition")}
        bind:value={definition}
      />
      <button class="primary" onclick={save} disabled={!saveTable}>
        <Save size={13} /> {$t("morphology.saveWord")}
      </button>
      {#if saved}<span class="muted">{$t("morphology.saved")}</span>{/if}
    </div>
  {/if}
</div>
