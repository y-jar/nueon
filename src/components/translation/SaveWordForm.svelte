<script lang="ts">
  import { t } from "svelte-i18n";
  import { Save } from "@lucide/svelte";
  import * as api from "../../lib/api";
  import { ui } from "../../lib/state.svelte";
  import { morphology as store } from "../../lib/morphology.svelte";

  interface Props {
    /** The word form to create. */
    surface: string;
    /** A definition suggestion, e.g. the gloss breakdown. */
    gloss: string;
    /** A word class (`pos`) to store on the new word. */
    wordClass?: string | null;
    /** A base word to record as the new word's parent (Reference). */
    lemma?: { table: string; id: string } | null;
  }

  let { surface, gloss, wordClass = null, lemma = null }: Props = $props();

  let table = $state("");
  let definition = $state("");
  let saved = $state(false);
  let violations = $state<api.PhonologyViolation[]>([]);

  const morphemeTables = $derived(
    new Set(store.morphemes.map((morpheme) => morpheme.table)),
  );
  const tables = $derived(
    ui.tables
      .filter((entry) => !morphemeTables.has(entry.name))
      .map((entry) => entry.name),
  );

  // Default the table: the lemma's own table first (so the Reference sticks),
  // then the last-used one, then the first vocabulary table.
  $effect(() => {
    if (lemma && tables.includes(lemma.table)) {
      table = lemma.table;
    } else if (ui.morphologySaveTable && tables.includes(ui.morphologySaveTable)) {
      table = ui.morphologySaveTable;
    } else if (tables.length) {
      table = tables[0];
    }
  });

  // Prefill the definition from the gloss breakdown.
  $effect(() => {
    definition = gloss;
    saved = false;
  });

  const duplicate = $derived(
    surface ? (ui.wordIndex[surface.trim().toLowerCase()] ?? []) : [],
  );

  // Re-check the surface against the sound inventory.
  $effect(() => {
    const word = surface.trim();
    if (!word) {
      violations = [];
      return;
    }
    let cancelled = false;
    void api
      .phonologyCheckWords([word])
      .then((result) => {
        if (!cancelled) violations = result[0] ?? [];
      })
      .catch(() => {
        if (!cancelled) violations = [];
      });
    return () => {
      cancelled = true;
    };
  });

  async function save() {
    const word = surface.trim();
    if (!table || !word) return;
    const id = await api.createTranslationWord(
      table,
      word,
      definition.trim(),
      [],
      wordClass,
    );
    if (!id) return;
    if (lemma && lemma.table === table) {
      await api.setParent(table, id, lemma.id).catch(() => {});
    }
    ui.morphologySaveTable = table;
    store.lexicon = await api.lexicon();
    saved = true;
    ui.status = $t("morphology.savedStatus", { values: { word } });
  }
</script>

<div class="save-word">
  <div class="compose-save">
    <select bind:value={table}>
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
    <button class="primary" onclick={save} disabled={!table || !surface}>
      <Save size={13} /> {$t("morphology.saveWord")}
    </button>
    {#if saved}<span class="muted">{$t("morphology.saved")}</span>{/if}
  </div>

  {#if duplicate.length}
    <p class="warn-inline">
      {$t("morphology.duplicate", { values: { word: surface } })}
    </p>
  {/if}
  {#if violations.length}
    <p class="warn-inline">{$t("morphology.phonotactic")}</p>
  {/if}
</div>
