<script lang="ts">
  import { X } from "@lucide/svelte";
  import { filterSuggestions } from "../lib/suggest";
  import SuggestionList from "./SuggestionList.svelte";

  interface Pill {
    id: string;
    label: string;
  }

  interface Props {
    pills: Pill[];
    placeholder: string;
    /** Values offered by the autocomplete (relations, or suggested tag values). */
    options?: { id: string; label: string }[];
    onAdd: (input: string) => void;
    onRemove: (id: string) => void;
  }

  let { pills, placeholder, options = [], onAdd, onRemove }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let draft = $state("");
  let active = $state(false);
  let highlight = $state(0);

  const labels = $derived(options.map((option) => option.label));
  const matches = $derived(filterSuggestions(labels, draft));
  const open = $derived(active && matches.length > 0);

  function commit(value: string) {
    const text = value.trim();
    if (!text) return;
    onAdd(text);
    draft = "";
    highlight = 0;
  }

  function pick(value: string) {
    commit(value);
    inputEl?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        highlight = Math.min(highlight + 1, matches.length - 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        highlight = Math.max(highlight - 1, 0);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        pick(matches[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        active = false;
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(draft);
    }
  }
</script>

<div class="pill-cell">
  {#each pills as pill (pill.id)}
    <span class="pill">
      {pill.label}
      <button
        onpointerdown={(e) => e.stopPropagation()}
        onclick={() => onRemove(pill.id)}
      >
        <X size={11} />
      </button>
    </span>
  {/each}
  <input
    class="pill-input"
    {placeholder}
    bind:this={inputEl}
    bind:value={draft}
    onfocus={() => (active = true)}
    oninput={(e) => {
      // Picking a suggestion fills the exact label; commit it right away.
      highlight = 0;
      const typed = e.currentTarget.value;
      if (labels.includes(typed)) commit(typed);
    }}
    onkeydown={onKeydown}
    onblur={() => {
      active = false;
      commit(draft);
    }}
  />
  {#if open}
    <SuggestionList anchor={inputEl} items={matches} {highlight} onPick={pick} />
  {/if}
</div>
