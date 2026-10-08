<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { ui, activeDoc } from "../lib/state.svelte";
  import TranslationToolbar from "./translation/TranslationToolbar.svelte";
  import MorphologyDrawer from "./translation/MorphologyDrawer.svelte";
  import SlotPalette from "./translation/SlotPalette.svelte";
  import ClauseCanvas from "./translation/ClauseCanvas.svelte";
  import TranslationRunner from "./translation/TranslationRunner.svelte";
  import type { SlotItem } from "./translation/types";

  const DRAFT_TAG = "draft";

  let presets = $state<api.SyntaxGrid[]>([]);
  let grammarRules = $state<api.GrammarRule[]>([]);
  let draftName = $state($t("translation.newPreset"));
  let slots = $state<SlotItem[]>([]);
  let separator = $state(" ");
  let affixes = $state<api.AffixRule[]>([]);
  let mode = $state<api.TranslationMode>("direct");
  let suggestions = $state<Record<number, api.WordHit[]>>({});
  let showMorphology = $state(false);
  let inputText = $state("");
  let choices = $state<Record<string, string>>({});
  let report = $state<api.TranslationReport | null>(null);
  let drafts = $state<
    Record<number, { table: string; wordname: string; tags: string }>
  >({});
  let error = $state("");

  const hasPreset = $derived(
    presets.some((preset) => preset.preset_name === draftName),
  );

  // Tag palette = union of all table tag names.
  const palette = $derived(
    Array.from(
      new Set(
        ui.tables
          .flatMap((table) => table.tags.map((tag) => tag.name))
          .filter(
            (name) =>
              name !== "wordname" &&
              name !== "parent" &&
              name !== "definition",
          ),
      ),
    ).sort(),
  );

  onMount(load);

  async function load() {
    await loadPresets();
    await loadOptions();
    await loadGrammar();
  }

  async function loadGrammar() {
    try {
      grammarRules = (await api.grammarGet()).rules;
    } catch (e) {
      error = String(e);
      return;
    }
    // Honour a default rule set in `config/translation`.
    try {
      const config = await api.translationConfig();
      if (config.default_rule) loadGrammarRule(config.default_rule);
    } catch {
      // A missing/unreadable config is not fatal.
    }
  }

  async function loadPresets() {
    try {
      presets = await api.listPresets();
    } catch (e) {
      error = String(e);
    }
  }

  async function loadOptions() {
    try {
      const options = await api.translationOptions();
      separator = options.separator;
      affixes = options.affixes;
      mode = options.mode;
    } catch (e) {
      error = String(e);
    }
  }

  async function persistOptions() {
    try {
      await api.setTranslationOptions({ separator, affixes, mode });
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function setMode(next: api.TranslationMode) {
    if (mode === next) return;
    mode = next;
    report = null;
    persistOptions();
  }

  function addAffix(rule: api.AffixRule) {
    affixes = [...affixes, rule];
    persistOptions();
  }

  function removeAffix(index: number) {
    affixes = affixes.filter((_, i) => i !== index);
    persistOptions();
  }

  function onSeparatorCommit() {
    persistOptions();
    run();
  }

  function toggleMorphology() {
    showMorphology = !showMorphology;
  }

  async function exportPresets() {
    const path = await save({
      defaultPath: "nueon-presets.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await api.exportPresets(path, presets);
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function importPresets() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const imported = await api.importPresets(selected);
      for (const preset of imported) {
        await api.savePreset(preset);
      }
      await loadPresets();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function newId(): string {
    return crypto.randomUUID();
  }

  function addSlot(slot: api.ClauseSlot) {
    slots = [...slots, { id: newId(), slot }];
  }

  function removeSlot(id: string) {
    slots = slots.filter((item) => item.id !== id);
  }

  function updateSlot(id: string, slot: api.ClauseSlot) {
    slots = slots.map((item) => (item.id === id ? { ...item, slot } : item));
  }

  function grid(): api.SyntaxGrid {
    return {
      preset_name: draftName.trim() || "untitled",
      slots: slots.map((item) => item.slot),
    };
  }

  async function savePreset() {
    try {
      await api.savePreset(grid());
      await loadPresets();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function loadPreset(name: string) {
    const preset = presets.find((p) => p.preset_name === name);
    if (!preset) return;
    draftName = preset.preset_name;
    slots = preset.slots.map((slot) => ({ id: newId(), slot }));
    report = null;
  }

  /** Pull a grammar rule's slots into the canvas, like loading a preset. */
  function loadGrammarRule(name: string) {
    const rule = grammarRules.find((candidate) => candidate.name === name);
    if (!rule) return;
    draftName = rule.name;
    slots = rule.slots.map((slot) => ({ id: newId(), slot }));
    report = null;
  }

  async function deletePreset(name: string) {
    await api.deletePreset(name);
    await loadPresets();
  }

  async function run() {
    try {
      report =
        mode === "direct"
          ? await api.executeTranslationDirect(inputText, choices)
          : await api.executeTranslation(inputText, grid(), choices);
      error = "";
      await loadSuggestions();
    } catch (e) {
      error = String(e);
    }
  }

  /** Search-as-you-type existing entries for each missing token. */
  async function loadSuggestions() {
    if (!report || mode !== "direct" || report.missing.length === 0) {
      suggestions = {};
      return;
    }
    const next: Record<number, api.WordHit[]> = {};
    await Promise.all(
      report.missing.map(async (index) => {
        const token = report?.tokens[index]?.text;
        if (!token) return;
        try {
          next[index] = await api.translationSuggest(token);
        } catch {
          next[index] = [];
        }
      }),
    );
    suggestions = next;
  }

  /** Point an existing word at this English token by adding it as a sense. */
  async function pickSuggestion(index: number, hit: api.WordHit) {
    const token = report?.tokens[index]?.normalized ?? report?.tokens[index]?.text;
    if (!token) return;
    try {
      const senses = hit.senses.some(
        (sense) => sense.toLowerCase() === token.toLowerCase(),
      )
        ? hit.senses
        : [...hit.senses, token];
      await api.setWordDefinition(hit.table, hit.id, senses);
      await run();
    } catch (e) {
      error = String(e);
    }
  }

  /** Create a stub word for every missing token at once. */
  async function createAllDrafts() {
    if (!report) return;
    const table =
      activeDoc().currentTable ?? ui.tables[0]?.name;
    if (!table) return;
    for (const index of [...report.missing]) {
      const token = report.tokens[index];
      if (!token) continue;
      try {
        await api.createTranslationWord(table, `*${token.text}*`, token.text, [
          DRAFT_TAG,
        ]);
      } catch {
        // Skip a token that already exists; the rest still go through.
      }
    }
    await run();
  }

  // Live preview in word-for-word mode (the default).
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    inputText;
    if (mode !== "direct") return;
    if (runTimer) clearTimeout(runTimer);
    runTimer = setTimeout(() => void run(), 300);
  });

  async function pickChoice(index: number, id: string) {
    choices = { ...choices, [String(index)]: id };
    // Re-evaluate mappings with the locked-in meaning (no re-parse needed).
    await run();
  }

  function missingDraft(index: number): {
    table: string;
    wordname: string;
    tags: string;
  } {
    return (
      drafts[index] ?? {
        table: activeDoc().currentTable ?? ui.tables[0]?.name ?? "",
        wordname: "",
        tags: "",
      }
    );
  }

  function setDraft(
    index: number,
    patch: Partial<{ table: string; wordname: string; tags: string }>,
  ) {
    drafts = { ...drafts, [index]: { ...missingDraft(index), ...patch } };
  }

  async function createMissing(index: number) {
    const draft = missingDraft(index);
    const token = report?.tokens[index];
    if (!draft.table || !draft.wordname.trim() || !token) return;
    const tags = draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    try {
      await api.createTranslationWord(
        draft.table,
        draft.wordname.trim(),
        token.text,
        tags,
      );
      drafts = { ...drafts };
      await run();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function createDraft(index: number) {
    const token = report?.tokens[index];
    const table =
      missingDraft(index).table || activeDoc().currentTable || ui.tables[0]?.name;
    if (!token || !table) return;
    const typed = missingDraft(index).wordname.trim();
    const wordname = typed || `*${token.text}*`;
    try {
      await api.createTranslationWord(table, wordname, token.text, [DRAFT_TAG]);
      drafts = { ...drafts };
      await run();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }
</script>

<div class="translation">
  <TranslationToolbar
    {presets}
    grammarRules={grammarRules.map((rule) => rule.name)}
    bind:draftName
    {hasPreset}
    {showMorphology}
    {mode}
    onLoad={loadPreset}
    onLoadGrammar={loadGrammarRule}
    onSave={savePreset}
    onDelete={() => deletePreset(draftName)}
    onExport={exportPresets}
    onImport={importPresets}
    onToggleMorphology={toggleMorphology}
    onSetMode={setMode}
  />

  <MorphologyDrawer
    open={showMorphology}
    {affixes}
    onAdd={addAffix}
    onRemove={removeAffix}
  />

  {#if mode === "grid"}
    <SlotPalette
      tags={palette}
      onAddTag={(name) => addSlot({ kind: "required_tag", tag: name })}
      onAddPrimitive={(slot) => addSlot(slot)}
    />

    <ClauseCanvas
      items={slots}
      tags={palette}
      {separator}
      onReorder={(items) => (slots = [...items])}
      onUpdate={updateSlot}
      onRemove={removeSlot}
      onDropSlot={(slot) => addSlot(slot)}
    />
  {/if}

  <TranslationRunner
    bind:inputText
    bind:separator
    {report}
    {choices}
    {drafts}
    {suggestions}
    {mode}
    tables={ui.tables}
    {error}
    onRun={run}
    onSeparatorCommit={onSeparatorCommit}
    onPickChoice={pickChoice}
    onSetDraft={setDraft}
    onCreateMissing={createMissing}
    onCreateDraft={createDraft}
    onPickSuggestion={pickSuggestion}
    onCreateAllDrafts={createAllDrafts}
  />
</div>
