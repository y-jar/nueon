<script lang="ts">
  import { t } from "svelte-i18n";
  import { ArrowLeft, ArrowRight, Check, Upload, X } from "@lucide/svelte";
  import * as api from "../../lib/api";
  import { ui, closeImport } from "../../lib/state.svelte";
  import StepSelect from "./steps/StepSelect.svelte";
  import StepMapping from "./steps/StepMapping.svelte";
  import StepPreview from "./steps/StepPreview.svelte";
  import StepReport from "./steps/StepReport.svelte";

  function defaultOptions(): api.ImportOptions {
    return {
      delimiter: ",",
      quote: '"',
      has_header: true,
      tag_list_delimiter: ",",
      tag_prefix: "#",
      parent_delimiter: ",",
      link_syntax: "wiki",
      roles: [],
      target_table: "",
      duplicate_policy: "skip",
      skip_placeholders: true,
      create_suffix_entries: false,
    };
  }

  const STEP_KEYS = ["select", "mapping", "preview", "report"] as const;

  let step = $state(1);
  let path = $state("");
  let options = $state<api.ImportOptions>(defaultOptions());
  let detection = $state<api.Detection | null>(null);
  let preview = $state<api.Preview | null>(null);
  let report = $state<api.ImportReport | null>(null);
  let busy = $state(false);

  // Start fresh every time the wizard is opened.
  $effect(() => {
    if (!ui.importOpen) return;
    step = 1;
    path = "";
    options = defaultOptions();
    detection = null;
    preview = null;
    report = null;
    busy = false;
  });

  function onDetected(_path: string, detected: api.Detection) {
    detection = detected;
    options.has_header = detected.has_header;
    options.delimiter = detected.delimiter;
    options.roles = detected.columns.map((column) => column.role);
  }

  const hasWordname = $derived(options.roles.some((r) => r.role === "wordname"));
  const canNext = $derived.by(() => {
    if (busy) return false;
    if (step === 1) return detection !== null;
    if (step === 2) return hasWordname && options.target_table.trim().length > 0;
    if (step === 3) return preview !== null;
    return false;
  });

  function next() {
    if (canNext) step += 1;
  }
  function back() {
    if (step > 1) step -= 1;
  }
  function close() {
    closeImport();
  }
  function onKey(event: KeyboardEvent) {
    if (ui.importOpen && event.key === "Escape" && !busy) close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.importOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget && !busy) close();
    }}
  >
    <div class="modal import-modal" role="dialog" aria-modal="true" aria-label={$t("import.title")}>
      <div class="modal-head">
        <span class="pane-title"><Upload size={15} /> {$t("import.title")}</span>
        <button onclick={close} disabled={busy} title={$t("grid.cancel")}>
          <X size={16} />
        </button>
      </div>

      <ol class="import-steps">
        {#each STEP_KEYS as key, i (key)}
          <li class:active={step === i + 1} class:done={step > i + 1}>
            <span class="dot">{i + 1}</span>
            {$t(`import.step_${key}`)}
          </li>
        {/each}
      </ol>

      <div class="modal-body import-body">
        {#if step === 1}
          <StepSelect
            bind:options
            bind:path
            {busy}
            {onDetected}
            onBusy={(b) => (busy = b)}
          />
        {:else if step === 2}
          <StepMapping bind:options {detection} />
        {:else if step === 3}
          <StepPreview {path} {options} bind:preview onBusy={(b) => (busy = b)} />
        {:else}
          <StepReport {path} {options} bind:report onBusy={(b) => (busy = b)} />
        {/if}
      </div>

      <div class="modal-foot">
        <span class="grow"></span>
        {#if step > 1}
          <button onclick={back} disabled={busy}>
            <ArrowLeft size={14} /> {$t("import.back")}
          </button>
        {/if}
        {#if step < 4}
          <button class="primary" onclick={next} disabled={!canNext}>
            {step === 3 ? $t("import.apply") : $t("import.next")}
            {#if step === 3}<Check size={14} />{:else}<ArrowRight size={14} />{/if}
          </button>
        {:else}
          <button class="primary" onclick={close} disabled={busy}>
            <Check size={14} /> {$t("import.done")}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
