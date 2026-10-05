<script lang="ts">
  import { X } from "@lucide/svelte";

  interface Pill {
    id: string;
    label: string;
  }

  interface Props {
    pills: Pill[];
    placeholder: string;
    /** Values offered by the autocomplete (relation columns). */
    options?: { id: string; label: string }[];
    onAdd: (input: string) => void;
    onRemove: (id: string) => void;
  }

  let { pills, placeholder, options = [], onAdd, onRemove }: Props = $props();

  const listId = `pill-options-${crypto.randomUUID()}`;
  let draft = $state("");
  // Only the focused cell mounts its datalist: one per cell would otherwise
  // multiply the dictionary size by the row count.
  let active = $state(false);

  function commit() {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    draft = "";
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
    bind:value={draft}
    list={options.length && active ? listId : undefined}
    onfocus={() => (active = true)}
    oninput={(e) => {
      // Picking a suggestion fills the exact label; commit it right away.
      const typed = e.currentTarget.value;
      if (options.some((option) => option.label === typed)) commit();
    }}
    onkeydown={(e) => e.key === "Enter" && commit()}
    onblur={() => {
      active = false;
      commit();
    }}
  />
  {#if options.length && active}
    <datalist id={listId}>
      {#each options as option (option.id)}
        <option value={option.label}></option>
      {/each}
    </datalist>
  {/if}
</div>
