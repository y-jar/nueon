<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowLeft, ArrowRight, Save, Search, Trash2, X } from "@lucide/svelte";
  import { ui } from "../../lib/state.svelte";
  import { morphology as store } from "../../lib/morphology.svelte";

  const DRAG_TYPE = "application/x-nueon-piece";

  interface Result {
    kind: "word" | "morpheme";
    id: string;
    label: string;
    gloss: string;
    sub: string;
  }

  let query = $state("");
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

  const results = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const words: Result[] = store.lexicon.map((word) => ({
      kind: "word",
      id: word.id,
      label: word.wordname,
      gloss: word.gloss,
      sub: word.class ?? word.table,
    }));
    const morphemes: Result[] = store.morphemes.map((morpheme) => ({
      kind: "morpheme",
      id: morpheme.wordname,
      label: morpheme.surface,
      gloss: morpheme.gloss,
      sub: $t(`morphology.${morpheme.kind}`),
    }));
    return [...words, ...morphemes]
      .filter(
        (result) =>
          !needle ||
          result.label.toLowerCase().includes(needle) ||
          result.gloss.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  });

  function add(result: Result) {
    if (result.kind === "word") {
      const word = store.lexicon.find((entry) => entry.id === result.id);
      if (word) store.addWord(word);
    } else {
      const morpheme = store.morphemes.find(
        (entry) => entry.wordname === result.id,
      );
      if (morpheme) store.addMorpheme(morpheme);
    }
    saved = false;
  }

  function dragStart(event: DragEvent, result: Result) {
    const payload = JSON.stringify({ kind: result.kind, id: result.id });
    event.dataTransfer?.setData(DRAG_TYPE, payload);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  }

  function onDragOver(event: DragEvent) {
    if (Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  }

  function onDrop(event: DragEvent) {
    const raw = event.dataTransfer?.getData(DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    const { kind, id } = JSON.parse(raw) as {
      kind: "word" | "morpheme";
      id: string;
    };
    add({ kind, id, label: "", gloss: "", sub: "" });
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
  <label class="explorer-filter">
    <Search size={13} />
    <input placeholder={$t("morphology.search")} bind:value={query} />
  </label>

  <div class="compose-results">
    {#each results as result (`${result.kind}-${result.id}`)}
      <button
        class="compose-result"
        class:is-morpheme={result.kind === "morpheme"}
        draggable="true"
        ondragstart={(event) => dragStart(event, result)}
        onclick={() => add(result)}
      >
        <span class="mono">{result.label}</span>
        <span class="muted grow">{result.gloss}</span>
        <span class="badge">{result.sub}</span>
      </button>
    {:else}
      <p class="muted small">{$t("morphology.noResults")}</p>
    {/each}
  </div>

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
