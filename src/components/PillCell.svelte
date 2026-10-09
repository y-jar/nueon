<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
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
  /** Highlighted suggestion; -1 until the user arrows to one. */
  let highlight = $state(-1);
  /** True once the user is deliberately browsing the list (↓/↑). */
  let browsing = $state(false);
  /** Escape hides the list until the next keystroke. */
  let closed = $state(false);

  const labels = $derived(options.map((option) => option.label));
  const matches = $derived(filterSuggestions(labels, draft));
  const open = $derived(
    active && !closed && matches.length > 0 && (browsing || draft.trim() !== ""),
  );

  function commit(value: string, refocus = true) {
    const text = value.trim();
    if (text) onAdd(text);
    draft = "";
    highlight = -1;
    browsing = false;
    // Keep the cell ready for another entry; skipped when blurring (Tab).
    if (refocus) inputEl?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      closed = false;
      // The first arrow press highlights the first/last suggestion; later
      // presses move the highlight.
      if (!browsing) {
        browsing = true;
        highlight = event.key === "ArrowDown" ? 0 : matches.length - 1;
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      highlight = Math.min(Math.max(highlight + delta, 0), matches.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (open && browsing && highlight >= 0) {
        commit(matches[highlight]);
      } else {
        commit(draft);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closed = true;
      browsing = false;
      highlight = -1;
    }
  }
</script>

<div class="pill-cell">
  <button
    type="button"
    class="pill-add"
    title={placeholder}
    onpointerdown={(e) => e.stopPropagation()}
    onclick={() => {
      inputEl?.focus();
      browsing = true;
      closed = false;
    }}
  >
    <Plus size={12} />
  </button>
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
      closed = false;
      browsing = false;
      highlight = -1;
      const typed = e.currentTarget.value;
      if (labels.includes(typed)) commit(typed);
    }}
    onkeydown={onKeydown}
    onblur={() => {
      active = false;
      browsing = false;
      closed = false;
      commit(draft, false);
    }}
  />
  {#if open}
    <SuggestionList anchor={inputEl} items={matches} {highlight} onPick={commit} />
  {/if}
</div>
