<script lang="ts">
  import { t } from "svelte-i18n";
  import { Search } from "@lucide/svelte";
  import { morphology as store } from "../../lib/morphology.svelte";

  let query = $state("");
  let open = $state(false);

  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return store.lexicon
      .filter(
        (word) =>
          word.wordname.toLowerCase().includes(needle) ||
          word.gloss.toLowerCase().includes(needle),
      )
      .slice(0, 30);
  });

  function choose(id: string) {
    store.selectWord(id);
    query = "";
    open = false;
  }
</script>

<div class="word-picker">
  <label class="explorer-filter">
    <Search size={13} />
    <input
      placeholder={$t("morphology.pickWordSearch")}
      bind:value={query}
      onfocus={() => (open = true)}
      onblur={() => setTimeout(() => (open = false), 150)}
    />
  </label>
  {#if open && matches.length}
    <div class="word-picker-list">
      {#each matches as entry (entry.id)}
        <button
          type="button"
          onpointerdown={(event) => event.preventDefault()}
          onclick={() => choose(entry.id)}
        >
          <span class="mono">{entry.wordname}</span>
          <span class="muted grow">{entry.gloss}</span>
          {#if entry.class}<span class="badge">{entry.class}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
