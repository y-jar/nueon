<script lang="ts">
  import { t } from "svelte-i18n";
  import { X } from "@lucide/svelte";
  import * as api from "../lib/api";

  interface Props {
    table: string;
    id: string;
    wordname: string;
    /** Words that directly descend from the one being deleted. */
    children: api.RelatedWord[];
    onClose: () => void;
    onDeleted: () => void | Promise<void>;
  }

  let { table, id, wordname, children, onClose, onDeleted }: Props = $props();

  /** child id → replacement parent id ("" = leave parentless). */
  let choices = $state<Record<string, string>>({});
  let candidates = $state<Record<string, api.RelatedWord[]>>({});
  let cascade = $state(false);
  let typed = $state("");
  let busy = $state(false);
  let error = $state("");

  $effect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, api.RelatedWord[]> = {};
      for (const child of children) {
        next[child.id] = await api.parentCandidates(child.id).catch(() => []);
      }
      if (!cancelled) candidates = next;
    })();
    return () => {
      cancelled = true;
    };
  });

  const canDelete = $derived(typed.trim() === wordname);

  async function confirm() {
    if (!canDelete || busy) return;
    busy = true;
    try {
      const reassignments = cascade
        ? []
        : children.map((child) => ({
            child: child.id,
            parent: choices[child.id] || null,
          }));
      await api.deleteWord(table, id, reassignments, cascade);
      await onDeleted();
      onClose();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-overlay"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="modal delete-word-modal"
    role="dialog"
    aria-modal="true"
    aria-label={$t("deleteWord.title")}
  >
    <div class="modal-head">
      <span class="pane-title">{$t("deleteWord.title")}</span>
      <button onclick={onClose} title={$t("grid.cancel")}><X size={16} /></button>
    </div>

    <div class="modal-body">
      <p class="muted">
        {$t("deleteWord.dependents", { values: { name: wordname } })}
      </p>

      <div class="dependents">
        {#each children as child (child.id)}
          <div class="dependent-row">
            <span class="grow">{child.wordname}</span>
            <select
              disabled={cascade}
              value={choices[child.id] ?? ""}
              onchange={(e) =>
                (choices = { ...choices, [child.id]: e.currentTarget.value })}
            >
              <option value="">{$t("deleteWord.leaveParentless")}</option>
              {#each candidates[child.id] ?? [] as candidate (candidate.id)}
                <option value={candidate.id}
                  >{$t("deleteWord.moveUnder", {
                    values: { name: candidate.wordname },
                  })}</option
                >
              {/each}
            </select>
          </div>
        {/each}
      </div>

      <label class="cascade-toggle">
        <input type="checkbox" bind:checked={cascade} />
        {$t("deleteWord.cascade")}
      </label>

      <label class="field"
        >{$t("deleteWord.typeName", { values: { name: wordname } })}
        <input bind:value={typed} autocomplete="off" />
      </label>

      {#if error}<p class="error">{error}</p>{/if}
    </div>

    <div class="modal-foot">
      <span class="grow"></span>
      <button onclick={onClose}>{$t("grid.cancel")}</button>
      <button class="danger" disabled={!canDelete || busy} onclick={confirm}>
        {$t("deleteWord.confirm")}
      </button>
    </div>
  </div>
</div>
