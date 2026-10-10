<!-- Morphology activity: classes, morphemes, paradigms. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Puzzle, RefreshCw, Search, X } from "@lucide/svelte";
  import {
    PIECE_DRAG_TYPE,
    morphology as store,
  } from "../lib/morphology.svelte";

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
      `${word.wordname} ${word.senses.join(" ")} ${word.class ?? ""} ${word.table}`
        .toLowerCase()
        .includes(wordFilter.trim().toLowerCase()),
    ),
  );

  /** The Endings tab owns class selection; the others add pieces. */
  const showingClasses = $derived(store.tab === "paradigms");

  function dragStart(event: DragEvent, kind: "word" | "morpheme", id: string) {
    event.dataTransfer?.setData(PIECE_DRAG_TYPE, JSON.stringify({ kind, id }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  }

  function addWord(word: (typeof store.lexicon)[number]) {
    if (store.tab === "inflect") store.selectWord(word.id);
    else store.addWord(word);
  }

  function addMorpheme(morpheme: (typeof store.morphemes)[number]) {
    if (store.tab === "inflect") store.toggleMorpheme(morpheme.wordname);
    else store.addMorpheme(morpheme);
  }

  const morphemeActive = (wordname: string) =>
    store.tab === "inflect" && store.manual.includes(wordname);

  /** Enter adds the top match; Escape clears the search. */
  function enterWord(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      wordFilter = "";
      return;
    }
    if (event.key !== "Enter" || !words.length) return;
    event.preventDefault();
    addWord(words[0]);
  }

  function enterMorpheme(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      morphFilter = "";
      return;
    }
    if (event.key !== "Enter" || !morphemes.length) return;
    event.preventDefault();
    addMorpheme(morphemes[0]);
  }

  function clearFilter(event: MouseEvent, clear: () => void) {
    // Keep the wrapping <label> from focusing the input.
    event.preventDefault();
    event.stopPropagation();
    clear();
  }
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

  {#if showingClasses}
    <section class="morph-region">
      <div class="section-title">{$t("morphology.classes")}</div>
      <div class="morph-chips">
        {#each classes as name (name)}
          <button
            class="morph-row class-row"
            class:active={store.selectedClass === name}
            onclick={() => (store.selectedClass = name)}
          >
            <Puzzle size={12} />
            <span class="grow">{name}</span>
          </button>
        {/each}
      </div>
    </section>
  {:else}
    <section class="morph-region">
      <div class="section-title">{$t("morphology.morphemes")}</div>
      <label class="explorer-filter morph-search">
        <Search size={13} />
        <input
          placeholder={$t("morphology.filterMorphemes")}
          bind:value={morphFilter}
          onkeydown={enterMorpheme}
        />
        {#if morphFilter}
          <button
            class="clear-search"
            type="button"
            title={$t("morphology.clear")}
            aria-label={$t("morphology.clear")}
            onclick={(event) => clearFilter(event, () => (morphFilter = ""))}
          >
            <X size={12} />
          </button>
        {/if}
      </label>
      <div class="morph-list">
        {#each morphemes as morpheme (`${morpheme.table}/${morpheme.wordname}`)}
          <button
            class="morph-row morpheme-row"
            class:active={morphemeActive(morpheme.wordname)}
            draggable="true"
            ondragstart={(event) =>
              dragStart(event, "morpheme", morpheme.wordname)}
            onclick={() => addMorpheme(morpheme)}
          >
            <span class="mono">{morpheme.surface}</span>
            <span class="muted grow gloss" title={morpheme.gloss}
              >{morpheme.gloss}</span
            >
            <span class="badge">{$t(`morphology.${morpheme.kind}`)}</span>
          </button>
        {:else}
          <p class="muted small">
            {morphFilter
              ? $t("morphology.noResults")
              : $t("morphology.noMorphemes")}
          </p>
        {/each}
      </div>
    </section>
  {/if}

  {#if !showingClasses}
    <section class="morph-region">
      <div class="section-title">{$t("morphology.lexicon")}</div>
      <label class="explorer-filter word-search">
        <Search size={13} />
        <input
          placeholder={$t("morphology.filter")}
          bind:value={wordFilter}
          onkeydown={enterWord}
        />
        {#if wordFilter}
          <button
            class="clear-search"
            type="button"
            title={$t("morphology.clear")}
            aria-label={$t("morphology.clear")}
            onclick={(event) => clearFilter(event, () => (wordFilter = ""))}
          >
            <X size={12} />
          </button>
        {/if}
      </label>
      <div class="morph-list">
        {#each words as word (word.id)}
          <button
            class="morph-row word-row"
            class:active={store.tab === "inflect" && store.selectedWord === word.id}
            draggable="true"
            ondragstart={(event) => dragStart(event, "word", word.id)}
            onclick={() => addWord(word)}
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
  {/if}
</aside>
