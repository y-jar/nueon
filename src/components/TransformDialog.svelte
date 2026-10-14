<!-- Transform dialog: numeric move, scale, rotate and skew, with an optional copy. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { editor, applyDialog, closeTransformDialog } from "../lib/writingEditor.svelte";
  import { DEFAULT_DIALOG, type DialogValues } from "../lib/writingTransform";

  let values = $state<DialogValues>({ ...DEFAULT_DIALOG });
  let copy = $state(false);
  function focusFirst(node: HTMLInputElement, wanted: boolean) {
    if (wanted) queueMicrotask(() => node.focus());
  }

  const FIELDS: { key: keyof DialogValues; unit: string }[] = [
    { key: "dx", unit: "units" },
    { key: "dy", unit: "units" },
    { key: "sx", unit: "%" },
    { key: "sy", unit: "%" },
    { key: "rotate", unit: "\u00b0" },
    { key: "skewX", unit: "\u00b0" },
    { key: "skewY", unit: "\u00b0" },
  ];

  function apply() {
    applyDialog(values, copy);
    closeTransformDialog();
  }

  function onKey(event: KeyboardEvent) {
    if (!editor.transformOpen) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      closeTransformDialog();
    } else if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
  }

  function reset() {
    values = { ...DEFAULT_DIALOG };
    copy = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if editor.transformOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeTransformDialog();
    }}
  >
    <div class="modal transform-dialog" role="dialog" aria-modal="true" aria-labelledby="transform-title">
      <div class="modal-head">
        <span id="transform-title" class="pane-title">{$t("writing.transform.title")}</span>
      </div>
      <div class="transform-body">
        <p class="muted">
          {editor.elements.length > 0
            ? $t("writing.transform.selected", { values: { count: editor.elements.length } })
            : $t("writing.transform.whole")}
        </p>
        {#each FIELDS as field, i (field.key)}
          <label class="transform-row">
            <span>{$t(`writing.transform.${field.key}`)}</span>
            <input
              type="number"
              step="any"
              data-field={field.key}
              bind:value={values[field.key]}
              use:focusFirst={i === 0}
            />
            <span class="muted">{field.unit}</span>
          </label>
        {/each}
        <label class="transform-copy">
          <input type="checkbox" data-field="copy" bind:checked={copy} />
          {$t("writing.transform.copy")}
        </label>
      </div>
      <div class="modal-foot">
        <button onclick={reset}>{$t("writing.transform.reset")}</button>
        <span class="grow"></span>
        <button onclick={closeTransformDialog}>{$t("writing.transform.cancel")}</button>
        <button class="primary" data-action="apply-transform" onclick={apply}>
          {$t("writing.transform.apply")}
        </button>
      </div>
    </div>
  </div>
{/if}
