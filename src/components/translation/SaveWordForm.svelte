<script lang="ts">
  import { t } from "svelte-i18n";
  import { Save, X } from "@lucide/svelte";
  import * as api from "../../lib/api";
  import { ui } from "../../lib/state.svelte";
  import { morphology as store } from "../../lib/morphology.svelte";

  /** A root to record as a parent of the new word (Reference). */
  interface ParentRef {
    table: string;
    id: string;
    label: string;
  }

  interface Props {
    /** The word form to create. */
    surface: string;
    /** A definition suggestion, e.g. the gloss breakdown. */
    gloss: string;
    /** A word class (`pos`) to store on the new word. */
    wordClass?: string | null;
    /** Roots to record as parents (by UUID, across any table). */
    parents?: ParentRef[];
    /** The table to default to, e.g. the one holding the most roots. */
    defaultTable?: string | null;
  }

  let {
    surface,
    gloss,
    wordClass = null,
    parents = [],
    defaultTable = null,
  }: Props = $props();

  let table = $state("");
  let definition = $state("");
  let saved = $state(false);
  let removed = $state<string[]>([]);
  let violations = $state<api.PhonologyViolation[]>([]);

  const kept = $derived(parents.filter((parent) => !removed.includes(parent.id)));

  const morphemeTables = $derived(
    new Set(store.morphemes.map((morpheme) => morpheme.table)),
  );
  const tables = $derived(
    ui.tables
      .filter((entry) => !morphemeTables.has(entry.name))
      .map((entry) => entry.name),
  );

  // Default the table: the suggested one first (so the most roots link), then
  // the last-used one, then the first vocabulary table.
  $effect(() => {
    if (defaultTable && tables.includes(defaultTable)) {
      table = defaultTable;
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
    for (const parent of kept) {
      await api.setParent(table, id, parent.id).catch(() => {});
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

  {#if kept.length}
    <div class="parent-chips">
      <span class="muted small">{$t("morphology.parents")}</span>
      {#each kept as parent (parent.id)}
        <span class="compose-chip parent-chip">
          <span class="mono">{parent.label}</span>
          <button
            class="chip-remove"
            title={$t("morphology.removeParent")}
            onclick={() => (removed = [...removed, parent.id])}
          >
            <X size={11} />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  {#if duplicate.length}
    <p class="warn-inline">
      {$t("morphology.duplicate", { values: { word: surface } })}
    </p>
  {/if}
  {#if violations.length}
    <p class="warn-inline">{$t("morphology.phonotactic")}</p>
  {/if}
</div>
