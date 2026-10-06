<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { RefreshCw, TriangleAlert } from "@lucide/svelte";
  import * as api from "../../../lib/api";

  interface Props {
    path: string;
    options: api.ImportOptions;
    preview: api.Preview | null;
    onBusy: (busy: boolean) => void;
  }

  let { path, options, preview = $bindable(), onBusy }: Props = $props();

  let error = $state("");

  async function run() {
    if (!path) return;
    onBusy(true);
    try {
      preview = await api.importPreview(path, options);
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      onBusy(false);
    }
  }

  onMount(() => {
    void run();
  });
</script>

<div class="import-step">
  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if preview}
    <div class="import-metrics">
      <div class="metric"><span class="num">{preview.words}</span><span>{$t("import.mWords")}</span></div>
      <div class="metric"><span class="num">{preview.rows_total}</span><span>{$t("import.mRows")}</span></div>
      <div class="metric"><span class="num">{preview.links.occurrences}</span><span>{$t("import.mLinks")}</span></div>
      <div class="metric"><span class="num">{preview.duplicates.length}</span><span>{$t("import.mDuplicates")}</span></div>
      <div class="metric"><span class="num">{preview.placeholders.length}</span><span>{$t("import.mPlaceholders")}</span></div>
      <div class="metric"><span class="num">{preview.short_rows.length}</span><span>{$t("import.mShort")}</span></div>
    </div>

    <div class="import-panels">
      <section>
        <h3>{$t("import.tagsToCreate")}</h3>
        {#if preview.tags.length}
          <div class="import-pills">
            {#each preview.tags as tag (tag.name)}
              <span class="pill">{tag.name} · {tag.kind}</span>
            {/each}
          </div>
        {:else}
          <p class="muted">{$t("import.none")}</p>
        {/if}
      </section>

      <section>
        <h3>{$t("import.links")}</h3>
        <ul class="import-list">
          <li>{$t("import.linkExact")}: {preview.links.exact.length}</li>
          <li>{$t("import.linkCase")}: {preview.links.case_only.length}</li>
          <li>{$t("import.linkUnresolved")}: {preview.links.unresolved.length}</li>
          <li>{$t("import.linkAmbiguous")}: {preview.links.ambiguous.length}</li>
        </ul>
        {#if preview.links.unresolved.length}
          <p class="muted import-note">
            {$t("import.unresolvedNote")}: {preview.links.unresolved.slice(0, 12).join(", ")}
          </p>
        {/if}
      </section>
    </div>

    {#if preview.duplicates.length}
      <section>
        <h3><TriangleAlert size={13} /> {$t("import.duplicates")}</h3>
        <div class="import-scroll">
          <table class="import-table">
            <thead><tr><th>{$t("import.mWords")}</th><th>{$t("import.existingIn")}</th></tr></thead>
            <tbody>
              {#each preview.duplicates.slice(0, 50) as dup (dup.wordname)}
                <tr>
                  <td>{dup.wordname}</td>
                  <td class="muted">{dup.existing_tables.join(", ")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if preview.suspicious.length}
      <section>
        <h3>{$t("import.suspicious")}</h3>
        <ul class="import-list">
          {#each preview.suspicious.slice(0, 20) as row (row.row + row.reason)}
            <li>{row.wordname}: {row.reason}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if preview.warnings.length}
      <ul class="import-warnings">
        {#each preview.warnings as warning (warning)}
          <li>{warning}</li>
        {/each}
      </ul>
    {/if}

    {#if preview.non_nfc_rows.length}
      <p class="error">
        {$t("import.nfcWarning", { values: { count: preview.non_nfc_rows.length } })}
      </p>
    {/if}

    <button class="import-rescan" onclick={run}>
      <RefreshCw size={13} /> {$t("import.refreshPreview")}
    </button>
  {:else if !error}
    <p class="muted">{$t("import.loadingPreview")}</p>
  {/if}
</div>
