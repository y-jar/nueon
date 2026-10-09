<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Puzzle, RefreshCw, Search } from "@lucide/svelte";
  import { morphology as store } from "../lib/morphology.svelte";

  onMount(() => void store.load());

  let wordFilter = $state("");
  let morphFilter = $state("");

  const classes = $derived(store.classNames());
  const morphemes = $derived(
    store.morphemes.filter((morpheme) =>
      `${morpheme.surface} ${morpheme.gloss}`
        .toLowerCase()
        .includes(morphFilter.trim().toLowerCase()),
    ),
  );
  const words = $derived(
    store.lexicon.filter((word) =>
      word.wordname.toLowerCase().includes(wordFilter.trim().toLowerCase()),
    ),
  );
</script>

<aside class="sidebar morphology-sidebar">
  <div class="pane-head">
    <span class="pane-title">{$t("morphology.title")}</span>
    <span class="actions">
      <button
        title={$t("morphology.refresh")}
        aria-label={$t("morphology.refresh")}
        onclick={() => store.load(true)}
      >
        <RefreshCw size={14} />
      </button>
    </span>
  </div>

  {#if store.error}<p class="error">{store.error}</p>{/if}

  <section class="morph-region">
    <div class="section-title">{$t("morphology.classes")}</div>
    <div class="morph-chips">
      {#each classes as name (name)}
        <button
          class="morph-row class-row"
          class:active={store.tab === "paradigms" && store.selectedClass === name}
          onclick={() => {
            store.selectedClass = name;
            store.tab = "paradigms";
          }}
        >
          <Puzzle size={12} />
          <span class="grow">{name}</span>
        </button>
      {/each}
    </div>
  </section>

  <section class="morph-region">
    <div class="section-title">{$t("morphology.morphemes")}</div>
    <label class="explorer-filter">
      <Search size={13} />
      <input
        placeholder={$t("morphology.filterMorphemes")}
        bind:value={morphFilter}
      />
    </label>
    <div class="morph-list">
      {#each morphemes as morpheme (`${morpheme.table}/${morpheme.wordname}`)}
        <label class="morph-row static morpheme-row">
          <input
            type="checkbox"
            checked={store.manual.includes(morpheme.wordname)}
            onchange={() => store.toggleMorpheme(morpheme.wordname)}
          />
          <span class="mono">{morpheme.surface}</span>
          <span class="muted grow gloss" title={morpheme.gloss}
            >{morpheme.gloss}</span
          >
          <span class="badge">{$t(`morphology.${morpheme.kind}`)}</span>
        </label>
      {:else}
        <p class="muted small">
          {morphFilter
            ? $t("morphology.noResults")
            : $t("morphology.noMorphemes")}
        </p>
      {/each}
    </div>
  </section>

  <section class="morph-region">
    <div class="section-title">{$t("morphology.lexicon")}</div>
    <label class="explorer-filter">
      <Search size={13} />
      <input placeholder={$t("morphology.filter")} bind:value={wordFilter} />
    </label>
    <div class="morph-list">
      {#each words as word (word.id)}
        <button
          class="morph-row word-row"
          class:active={store.tab === "inflect" && store.selectedWord === word.id}
          onclick={() => store.selectWord(word.id)}
        >
          <span class="grow">{word.wordname}</span>
          {#if word.class}<span class="badge">{word.class}</span>{/if}
          <span class="muted gloss" title={word.gloss}>{word.gloss}</span>
        </button>
      {:else}
        <p class="muted small">
          {wordFilter ? $t("morphology.noResults") : $t("morphology.noWords")}
        </p>
      {/each}
    </div>
  </section>
</aside>
