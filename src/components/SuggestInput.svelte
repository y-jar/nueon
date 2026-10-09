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
  let highlight = $state(0);

  // Show the stored value, and follow it while the field is not being edited.
  $effect(() => {
    if (!active) draft = value;
  });

  const matches = $derived(filterSuggestions(suggestions, draft));
  const open = $derived(active && matches.length > 0);

  function accept(next: string) {
    draft = next;
    onInput?.(next);
    onCommit(next);
    active = false;
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
        accept(matches[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        active = false;
        return;
      }
    }
    if (event.key === "Enter") {
      if (onEnter) {
        event.preventDefault();
        onEnter();
      } else {
        inputEl?.blur();
      }
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
      highlight = 0;
      onInput?.(e.currentTarget.value);
    }}
    onkeydown={onKeydown}
    onblur={() => {
      active = false;
      onCommit(draft);
    }}
  />
  {#if open}
    <SuggestionList anchor={inputEl} items={matches} {highlight} onPick={accept} />
  {/if}
</div>
