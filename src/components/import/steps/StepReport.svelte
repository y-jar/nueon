<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { CircleAlert, GitBranch } from "@lucide/svelte";
  import * as api from "../../../lib/api";
  import { selectTable } from "../../../lib/state.svelte";

  interface Props {
    path: string;
    options: api.ImportOptions;
    report: api.ImportReport | null;
    onBusy: (busy: boolean) => void;
  }

  let { path, options, report = $bindable(), onBusy }: Props = $props();

  let error = $state("");
  let started = false;

  async function run() {
    onBusy(true);
    try {
      const plan: api.ImportPlan = {
        source: path,
        options,
        link_choices: {},
        duplicate_choices: {},
      };
      report = await api.importApply(plan);
      error = "";
      if (report) await selectTable(report.table);
    } catch (e) {
      error = String(e);
    } finally {
      onBusy(false);
    }
  }

  onMount(() => {
    if (started) return;
    started = true;
    void run();
  });
</script>

<div class="import-step">
  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if report}
    <div class="import-metrics">
      <div class="metric"><span class="num">{report.words_created}</span><span>{$t("import.rCreated")}</span></div>
      <div class="metric"><span class="num">{report.words_updated}</span><span>{$t("import.rUpdated")}</span></div>
      <div class="metric"><span class="num">{report.words_skipped}</span><span>{$t("import.rSkipped")}</span></div>
      <div class="metric"><span class="num">{report.parents_linked}</span><span>{$t("import.rParents")}</span></div>
      <div class="metric"><span class="num">{report.tags_created.length}</span><span>{$t("import.rTags")}</span></div>
      <div class="metric"><span class="num">{report.suffix_entries}</span><span>{$t("import.rSuffix")}</span></div>
    </div>

    {#if report.warnings.length}
      <ul class="import-warnings">
        {#each report.warnings as warning (warning)}
          <li><CircleAlert size={12} /> {warning}</li>
        {/each}
      </ul>
    {/if}

    <p class="muted import-note">
      <GitBranch size={12} /> {$t("import.revertNote")}
    </p>
  {:else if !error}
    <p class="muted">{$t("import.applying")}</p>
  {/if}
</div>
