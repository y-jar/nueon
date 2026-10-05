<script lang="ts">
  import { t } from "svelte-i18n";
  import { Sparkles } from "@lucide/svelte";
  import type {
    Symbol,
    TableSummary,
    TranslationReport,
    WordHit,
  } from "../../lib/api";
  import { ui } from "../../lib/state.svelte";
  import InterlinearGloss from "../InterlinearGloss.svelte";

  interface Draft {
    table: string;
    wordname: string;
    tags: string;
  }

  interface Props {
    inputText: string;
    separator: string;
    report: TranslationReport | null;
    choices: Record<string, string>;
    drafts: Record<number, Draft>;
    tables: TableSummary[];
    error: string;
    onRun: () => void;
    onSeparatorCommit: () => void;
    onPickChoice: (index: number, id: string) => void;
    onSetDraft: (index: number, patch: Partial<Draft>) => void;
    onCreateMissing: (index: number) => void;
    onCreateDraft: (index: number) => void;
  }

  let {
    inputText = $bindable(),
    separator = $bindable(),
    report,
    choices,
    drafts,
    tables,
    error,
    onRun,
    onSeparatorCommit,
    onPickChoice,
    onSetDraft,
    onCreateMissing,
    onCreateDraft,
  }: Props = $props();

  function candidatesFor(index: number): WordHit[] {
    const token = report?.tokens[index];
    if (!token) return [];
    return ui.wordIndex[token.normalized] ?? [];
  }

  function missingDraft(index: number): Draft {
    return (
      drafts[index] ?? {
        table: ui.currentTable ?? tables[0]?.name ?? "",
        wordname: "",
        tags: "",
      }
    );
  }

  function symbolText(symbol: Symbol): string {
    switch (symbol.kind) {
      case "word":
        return symbol.value;
      case "literal":
        return `"${symbol.value}"`;
      case "separator":
        return symbol.value ? symbol.value : "␣";
      case "placeholder":
        return `⟨${symbol.value}⟩`;
    }
  }
</script>

<div class="runner">
  <div class="exec-bar">
    <label class="separator-field">
      <span class="muted">{$t("translation.separator")}</span>
      <input
        bind:value={separator}
        size="3"
        onblur={onSeparatorCommit}
      />
    </label>
    <textarea
      placeholder={$t("translation.englishPlaceholder")}
      bind:value={inputText}
      rows="2"
    ></textarea>
    <button class="translate" onclick={onRun}>
      <Sparkles size={15} /> {$t("translation.translate")}
    </button>
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  {#if report}
    <div class="output-panel">
      <div class="output-row">
        <div class="output">{report.output || $t("translation.empty")}</div>
        <span
          class="status-badge"
          class:ok={report.complete}
          class:warn={!report.complete}
        >
          {report.complete
            ? $t("translation.complete")
            : $t("translation.incomplete")}
        </span>
      </div>

      <InterlinearGloss gloss={report.gloss} />

      {#if report.conflicts.length}
        <div class="section-title">{$t("translation.conflicts")}</div>
        {#each report.conflicts as index (index)}
          <div class="row">
            <span class="muted">{report.tokens[index]?.text}</span>
            <select
              value={choices[String(index)] ?? ""}
              onchange={(e) => onPickChoice(index, e.currentTarget.value)}
            >
              <option value="">{$t("translation.choose")}</option>
              {#each candidatesFor(index) as hit (hit.id)}
                <option value={hit.id}>{hit.wordname} · {hit.table}</option>
              {/each}
            </select>
          </div>
        {/each}
      {/if}

      {#if report.missing.length}
        <div class="section-title">{$t("translation.missingWords")}</div>
        {#each report.missing as index (index)}
          <div class="row">
            <span class="muted">{report.tokens[index]?.text}</span>
            <select
              value={missingDraft(index).table}
              onchange={(e) =>
                onSetDraft(index, { table: e.currentTarget.value })}
            >
              {#each tables as table (table.name)}
                <option value={table.name}>{table.name}</option>
              {/each}
            </select>
            <input
              placeholder={$t("translation.wordname")}
              value={missingDraft(index).wordname}
              oninput={(e) =>
                onSetDraft(index, { wordname: e.currentTarget.value })}
            />
            <input
              placeholder={$t("translation.tagsComma")}
              value={missingDraft(index).tags}
              oninput={(e) => onSetDraft(index, { tags: e.currentTarget.value })}
            />
            <button onclick={() => onCreateMissing(index)}
              >{$t("translation.create")}</button
            >
            <button onclick={() => onCreateDraft(index)}
              >{$t("translation.draft")}</button
            >
          </div>
        {/each}
      {/if}

      {#if report.unfilled.length}
        <div class="section-title">{$t("translation.unfilledSlots")}</div>
        <p class="muted">
          {#each report.unfilled as index (index)}
            {#if index > 0}, {/if}{$t("translation.slot", {
              values: { index },
            })}
          {/each}
        </p>
      {/if}

      <div class="section-title">{$t("translation.breakdown")}</div>
      {#each report.slots as outcome (outcome.index)}
        <div class="row">
          <span class="muted">{outcome.slot.kind} {outcome.index}</span>
          <span>→</span>
          <span class="mono">{symbolText(outcome.symbol)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
