<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";
  import TranslationToolbar from "./translation/TranslationToolbar.svelte";
  import MorphologyDrawer from "./translation/MorphologyDrawer.svelte";
  import SlotPalette from "./translation/SlotPalette.svelte";
  import ClauseCanvas from "./translation/ClauseCanvas.svelte";
  import TranslationRunner from "./translation/TranslationRunner.svelte";
  import type { SlotItem } from "./translation/types";

  const DRAFT_TAG = "draft";

  let presets = $state<api.SyntaxGrid[]>([]);
  let draftName = $state($t("translation.newPreset"));
  let slots = $state<SlotItem[]>([]);
  let separator = $state(" ");
  let affixes = $state<api.AffixRule[]>([]);
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
    } catch (e) {
      error = String(e);
    }
  }

  async function persistOptions() {
    try {
      await api.setTranslationOptions({ separator, affixes });
      error = "";
    } catch (e) {
      error = String(e);
    }
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
      defaultPath: "langloom-presets.json",
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

  async function deletePreset(name: string) {
    await api.deletePreset(name);
    await loadPresets();
  }

  async function run() {
    try {
      report = await api.executeTranslation(inputText, grid(), choices);
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

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
        table: ui.currentTable ?? ui.tables[0]?.name ?? "",
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
      missingDraft(index).table || ui.currentTable || ui.tables[0]?.name;
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
    bind:draftName
    {hasPreset}
    {showMorphology}
    onLoad={loadPreset}
    onSave={savePreset}
    onDelete={() => deletePreset(draftName)}
    onExport={exportPresets}
    onImport={importPresets}
    onToggleMorphology={toggleMorphology}
  />

  <MorphologyDrawer
    open={showMorphology}
    {affixes}
    onAdd={addAffix}
    onRemove={removeAffix}
  />

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

  <TranslationRunner
    bind:inputText
    bind:separator
    {report}
    {choices}
    {drafts}
    tables={ui.tables}
    {error}
    onRun={run}
    onSeparatorCommit={onSeparatorCommit}
    onPickChoice={pickChoice}
    onSetDraft={setDraft}
    onCreateMissing={createMissing}
    onCreateDraft={createDraft}
  />
</div>
