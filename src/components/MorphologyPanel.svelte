<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Puzzle, RefreshCw } from "@lucide/svelte";
  import { morphology } from "../lib/morphology.svelte";

  onMount(() => void morphology.load());

  const classes = $derived(morphology.classNames());
</script>

<aside class="sidebar">
  <div class="pane-head">
    <span class="pane-title">{$t("morphology.title")}</span>
    <span class="actions">
      <button
        title={$t("morphology.refresh")}
        aria-label={$t("morphology.refresh")}
        onclick={() => morphology.load(true)}
      >
        <RefreshCw size={14} />
      </button>
    </span>
  </div>

  {#if morphology.error}<p class="error">{morphology.error}</p>{/if}

  <div class="section-title">{$t("morphology.classes")}</div>
  <div class="morph-list">
    {#each classes as name (name)}
      <button
        class="morph-row"
        class:active={morphology.selectedClass === name}
        onclick={() => (morphology.selectedClass = name)}
      >
        <Puzzle size={13} />
        <span class="grow">{name}</span>
      </button>
    {/each}
  </div>

  <div class="section-title">{$t("morphology.morphemes")}</div>
  {#if morphology.morphemes.length === 0}
    <p class="muted small">{$t("morphology.noMorphemes")}</p>
  {:else}
    <div class="morph-list">
      {#each morphology.morphemes as morpheme (`${morpheme.table}/${morpheme.wordname}`)}
        <div class="morph-row static">
          <span class="mono">{morpheme.surface}</span>
          <span class="muted grow">{morpheme.gloss}</span>
          <span class="badge">{$t(`morphology.${morpheme.kind}`)}</span>
        </div>
      {/each}
    </div>
  {/if}
</aside>
