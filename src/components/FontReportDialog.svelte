<!-- Font export report: problems found per glyph, with a gated export button. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { editor, closeReport, exportFont } from "../lib/writingEditor.svelte";
  import { canExport, groupIssues, summarise } from "../lib/fontReport";

  const report = $derived(editor.report);
  const groups = $derived(report ? groupIssues(report.issues) : []);
  const counts = $derived(report ? summarise(report.issues) : null);
  const allowed = $derived(report ? canExport(report.issues) : false);

  let closeButton = $state<HTMLButtonElement | null>(null);
  $effect(() => {
    if (report) closeButton?.focus();
  });

  function onKey(event: KeyboardEvent) {
    if (report && event.key === "Escape") {
      event.stopPropagation();
      closeReport();
    }
  }

  async function exportNow() {
    const path = await saveDialog({
      defaultPath: "script.ttf",
      filters: [{ name: "TrueType font", extensions: ["ttf"] }],
    });
    if (!path) return;
    closeReport();
    await exportFont(path);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if report && counts}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeReport();
    }}
  >
    <div
      class="modal font-report"
      role="dialog"
      aria-modal="true"
      aria-labelledby="font-report-title"
    >
      <div class="modal-head">
        <span id="font-report-title" class="pane-title">{$t("writing.report.title")}</span>
      </div>
      <div class="font-report-body">
        <p class="font-report-summary" data-testid="font-report-summary">
          {#if report.issues.length === 0}
            {$t("writing.report.clean")}
          {:else}
            {$t("writing.report.summary", {
              values: { errors: counts.error, warnings: counts.warning, notes: counts.info },
            })}
          {/if}
        </p>
        {#each groups as group (group.glyph)}
          <section class="font-report-group">
            <h4 class="severity-{group.worst}">{group.name}</h4>
            <ul>
              {#each group.issues as issue, index (index)}
                <li class="severity-{issue.severity}" data-code={issue.code}>
                  <span class="badge">{$t(`writing.report.${issue.severity}`)}</span>
                  {issue.message}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
        {#if !allowed}
          <p class="font-report-blocked">{$t("writing.report.blocked")}</p>
        {/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button bind:this={closeButton} onclick={closeReport}>{$t("writing.report.close")}</button>
        {#if report.exporting}
          <button class="primary" disabled={!allowed} onclick={exportNow}>
            {$t("writing.report.export")}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
