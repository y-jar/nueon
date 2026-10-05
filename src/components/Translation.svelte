<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { dndzone } from "svelte-dnd-action";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";

  interface SlotItem {
    id: string;
    slot: api.ClauseSlot;
  }

  const DRAFT_TAG = "draft";

  let presets = $state<api.SyntaxGrid[]>([]);
  let draftName = $state($t("translation.newPreset"));
  let slots = $state<SlotItem[]>([]);
  let separator = $state(" ");
  let affixes = $state<api.AffixRule[]>([]);
  let newAffixKind = $state("suffix");
  let newAffixEnglish = $state("");
  let newAffixConlang = $state("");
  let inputText = $state("");
  let choices = $state<Record<string, string>>({});
  let report = $state<api.TranslationReport | null>(null);
  let drafts = $state<
    Record<number, { table: string; wordname: string; tags: string }>
  >({});
  let error = $state("");

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

  async function addAffix() {
    const english = newAffixEnglish.trim();
    const conlang = newAffixConlang.trim();
    if (!english || !conlang) return;
    affixes = [
      ...affixes,
      { kind: newAffixKind as api.AffixKind, english, conlang },
    ];
    newAffixEnglish = "";
    newAffixConlang = "";
    await persistOptions();
  }

  async function removeAffix(index: number) {
    affixes = affixes.filter((_, i) => i !== index);
    await persistOptions();
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

  function handleDnd(event: CustomEvent<{ items: SlotItem[] }>) {
    // Guideline: operate on the immutable array the action provides.
    slots = [...event.detail.items];
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

  function setDraft(index: number, patch: Partial<{ table: string; wordname: string; tags: string }>) {
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

  function candidatesFor(index: number): api.WordHit[] {
    const token = report?.tokens[index];
    if (!token) return [];
    return ui.wordIndex[token.normalized] ?? [];
  }

  function symbolText(symbol: api.Symbol): string {
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

<div class="translation">
  <div class="grid-toolbar">
    <select
      onchange={(e) => {
        const value = e.currentTarget.value;
        if (value) loadPreset(value);
        e.currentTarget.value = "";
      }}
    >
      <option value="">{$t("translation.loadPreset")}</option>
      {#each presets as preset (preset.preset_name)}
        <option value={preset.preset_name}>{preset.preset_name}</option>
      {/each}
    </select>
    <input placeholder={$t("translation.presetName")} bind:value={draftName} />
    <button onclick={savePreset}>{$t("translation.savePreset")}</button>
    {#if presets.some((p) => p.preset_name === draftName)}
      <button onclick={() => deletePreset(draftName)}>{$t("translation.delete")}</button>
    {/if}
    <button onclick={exportPresets}>{$t("translation.exportPresets")}</button>
    <button onclick={importPresets}>{$t("translation.importPresets")}</button>
  </div>

  <details class="options">
    <summary>{$t("translation.morphology")}</summary>
    <div class="picker-body">
      {#each affixes as rule, index (index)}
        <div class="row">
          <span class="muted">{rule.kind}</span>
          <span class="mono">{rule.english} → {rule.conlang}</span>
          <button onclick={() => removeAffix(index)}>✕</button>
        </div>
      {/each}
      <div class="row">
        <select bind:value={newAffixKind}>
          <option value="suffix">{$t("translation.suffix")}</option>
          <option value="prefix">{$t("translation.prefix")}</option>
        </select>
        <input
          placeholder={$t("translation.englishAffix")}
          bind:value={newAffixEnglish}
        />
        <input
          placeholder={$t("translation.conlangAffix")}
          bind:value={newAffixConlang}
        />
        <button onclick={addAffix}>{$t("translation.add")}</button>
      </div>
    </div>
  </details>

  <div class="builder">
    <div class="palette">
      <div class="pane-title">{$t("translation.tags")}</div>
      {#each palette as name (name)}
        <button
          class="chip"
          onclick={() => addSlot({ kind: "required_tag", tag: name })}
          >#{name}</button
        >
      {/each}
      <div class="pane-title">{$t("translation.add")}</div>
      <div class="chip-row">
        <button
          class="chip"
          onclick={() => addSlot({ kind: "literal", text: "ka" })}
          >{$t("translation.literal")}</button
        >
        <button class="chip" onclick={() => addSlot({ kind: "wildcard" })}
          >{$t("translation.wildcard")}</button
        >
        <button class="chip" onclick={() => addSlot({ kind: "spacer" })}
          >{$t("translation.spacer")}</button
        >
      </div>
    </div>

    <div
      class="slot-list"
      use:dndzone={{ items: slots, flipDurationMs: 120 }}
      onconsider={handleDnd}
      onfinalize={handleDnd}
    >
      {#each slots as item (item.id)}
        <div class="slot-card">
          <span class="grip">⠿</span>
          {#if item.slot.kind === "required_tag"}
            <span>#</span>
            <select
              value={item.slot.tag}
              onpointerdown={(e) => e.stopPropagation()}
              onchange={(e) =>
                updateSlot(item.id, {
                  kind: "required_tag",
                  tag: e.currentTarget.value,
                })}
            >
              {#each palette as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          {:else if item.slot.kind === "literal"}
            <input
              value={item.slot.text}
              onpointerdown={(e) => e.stopPropagation()}
              onblur={(e) =>
                updateSlot(item.id, {
                  kind: "literal",
                  text: e.currentTarget.value,
                })}
            />
          {:else if item.slot.kind === "wildcard"}
            <em>{$t("translation.wildcardLabel")}</em>
          {:else}
            <em>{$t("translation.spacerLabel")}</em>
            <input
              value={item.slot.text ?? ""}
              placeholder={separator}
              size="4"
              onpointerdown={(e) => e.stopPropagation()}
              onblur={(e) =>
                updateSlot(item.id, {
                  kind: "spacer",
                  text: e.currentTarget.value || null,
                })}
            />
          {/if}
          <button onclick={() => removeSlot(item.id)}>✕</button>
        </div>
      {/each}
      {#if slots.length === 0}
        <p class="muted">{$t("translation.emptyHint")}</p>
      {/if}
    </div>
  </div>

  <div class="runner">
    <div class="row">
      <span class="muted">{$t("translation.separator")}</span
      ><input bind:value={separator} size="3" onblur={() => {
        persistOptions();
        run();
      }} />
      <textarea
        placeholder={$t("translation.englishPlaceholder")}
        bind:value={inputText}
        rows="2"
      ></textarea>
      <button onclick={run}>{$t("translation.translate")}</button>
    </div>

    {#if error}<p class="error">{error}</p>{/if}

    {#if report}
      <div class="output">{report.output || $t("translation.empty")}</div>
      <div class:ok={report.complete} class:warn={!report.complete}>
        {report.complete ? $t("translation.complete") : $t("translation.incomplete")}
      </div>

      {#if report.conflicts.length}
        <div class="section-title">{$t("translation.conflicts")}</div>
        {#each report.conflicts as index (index)}
          <div class="row">
            <span class="muted">{report.tokens[index]?.text}</span>
            <select
              value={choices[String(index)] ?? ""}
              onchange={(e) => pickChoice(index, e.currentTarget.value)}
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
                setDraft(index, { table: e.currentTarget.value })}
            >
              {#each ui.tables as table (table.name)}
                <option value={table.name}>{table.name}</option>
              {/each}
            </select>
            <input
              placeholder={$t("translation.wordname")}
              value={missingDraft(index).wordname}
              oninput={(e) =>
                setDraft(index, { wordname: e.currentTarget.value })}
            />
            <input
              placeholder={$t("translation.tagsComma")}
              value={missingDraft(index).tags}
              oninput={(e) => setDraft(index, { tags: e.currentTarget.value })}
            />
            <button onclick={() => createMissing(index)}
              >{$t("translation.create")}</button
            >
            <button onclick={() => createDraft(index)}
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
    {/if}
  </div>
</div>
