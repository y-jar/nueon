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
    list={options.length ? listId : undefined}
    onkeydown={(e) => e.key === "Enter" && commit()}
    onblur={commit}
  />
  {#if options.length}
    <datalist id={listId}>
      {#each options as option (option.id)}
        <option value={option.label}></option>
      {/each}
    </datalist>
  {/if}
</div>
