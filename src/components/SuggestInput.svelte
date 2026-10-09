<script lang="ts">
  import { filterSuggestions } from "../lib/suggest";
  import SuggestionList from "./SuggestionList.svelte";

  interface Props {
    value: string;
    placeholder?: string;
    type?: string;
    /** Existing values offered as the user types. */
    suggestions: string[];
    /** Live updates while typing (the add-word wizard). */
    onInput?: (value: string) => void;
    /** Committed on blur and when a suggestion is accepted. */
    onCommit: (value: string) => void;
    /** Enter with the suggestion list closed (default: blur to commit). */
    onEnter?: () => void;
  }

  let {
    value,
    placeholder = "",
    type = "text",
    suggestions,
    onInput,
    onCommit,
    onEnter,
  }: Props = $props();

  let inputEl = $state<HTMLInputElement | null>(null);
  let draft = $state("");
  let active = $state(false);
  let highlight = $state(-1);
  let browsing = $state(false);
  let closed = $state(false);

  // Show the stored value, and follow it while the field is not being edited.
  $effect(() => {
    if (!active) draft = value;
  });

  const matches = $derived(filterSuggestions(suggestions, draft));
  const open = $derived(
    active && !closed && matches.length > 0 && (browsing || draft.trim() !== ""),
  );

  function accept(next: string) {
    draft = next;
    onInput?.(next);
    onCommit(next);
    browsing = false;
    closed = false;
    highlight = -1;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      closed = false;
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
        accept(matches[highlight]);
      } else if (onEnter) {
        onEnter();
      } else {
        inputEl?.blur();
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

<div class="suggest-input">
  <input
    {type}
    {placeholder}
    bind:this={inputEl}
    bind:value={draft}
    onfocus={() => (active = true)}
    oninput={(e) => {
      closed = false;
      browsing = false;
      highlight = -1;
      onInput?.(e.currentTarget.value);
    }}
    onkeydown={onKeydown}
    onblur={() => {
      active = false;
      browsing = false;
      closed = false;
      onCommit(draft);
    }}
  />
  {#if open}
    <SuggestionList anchor={inputEl} items={matches} {highlight} onPick={accept} />
  {/if}
</div>
