<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Plus, X, Trash2 } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";
  import { BACKNESS, CONSONANTS, PLACES, VOWELS } from "../lib/ipa";

  let phonemes = $state<api.Phoneme[]>([]);
  let syllables = $state<string[]>([]);
  let rules = $state<api.SoundChangeRule[]>([]);
  let customSymbol = $state("");
  let customKind = $state<api.PhonemeKind>("consonant");
  let newSyllable = $state("");
  let status = $state("");
  let error = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previewWord = $state("");
  let previewSteps = $state<string[]>([]);
  let applyTable = $state("");
  let applyCount = $state<number | null>(null);

  const chosen = $derived(new Set(phonemes.map((phoneme) => phoneme.symbol)));
  const consonantCount = $derived(
    phonemes.filter((phoneme) => phoneme.kind === "consonant").length,
  );
  const vowelCount = $derived(
    phonemes.filter((phoneme) => phoneme.kind === "vowel").length,
  );

  const SYLLABLE_PRESETS = ["V", "CV", "VC", "CVC", "CCV", "CCVC", "CVCC"];

  onMount(load);

  // Reload when another editor (Settings' sound-class fields) writes the
  // phonology config, so this view's local copy cannot clobber it.
  let revisionSeen = ui.phonologyRevision;
  $effect(() => {
    if (ui.phonologyRevision === revisionSeen) return;
    revisionSeen = ui.phonologyRevision;
    void load();
  });

  async function load() {
    try {
      const config = await api.phonologyGet();
      phonemes = config.phonemes;
      syllables = config.syllables;
      rules = config.rules ?? [];
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 400);
  }

  async function save() {
    try {
      await api.phonologySet({ phonemes, syllables, rules });
      status = $t("phonology.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function toggle(symbol: string, kind: api.PhonemeKind) {
    if (chosen.has(symbol)) {
      phonemes = phonemes.filter((phoneme) => phoneme.symbol !== symbol);
    } else {
      phonemes = [...phonemes, { symbol, kind }];
    }
    scheduleSave();
  }

  function removePhoneme(symbol: string) {
    phonemes = phonemes.filter((phoneme) => phoneme.symbol !== symbol);
    scheduleSave();
  }

  function addCustom() {
    const symbol = customSymbol.trim();
    if (!symbol || chosen.has(symbol)) {
      customSymbol = "";
      return;
    }
    phonemes = [...phonemes, { symbol, kind: customKind }];
    customSymbol = "";
    scheduleSave();
  }

  function clearInventory() {
    phonemes = [];
    scheduleSave();
  }

  function addSyllable(shape: string) {
    const value = shape.trim().toUpperCase();
    if (!value || syllables.includes(value)) return;
    syllables = [...syllables, value];
    scheduleSave();
  }

  function removeSyllable(shape: string) {
    syllables = syllables.filter((value) => value !== shape);
    scheduleSave();
  }

  function addRule() {
    rules = [...rules, { from: "", to: "", left: "", right: "" }];
  }

  function removeRule(index: number) {
    rules = rules.filter((_, i) => i !== index);
    scheduleSave();
  }

  function updateRule(index: number, field: keyof api.SoundChangeRule, value: string) {
    rules = rules.map((rule, i) => (i === index ? { ...rule, [field]: value } : rule));
    scheduleSave();
  }

  async function runPreview() {
    const word = previewWord.trim();
    if (!word) {
      previewSteps = [];
      return;
    }
    try {
      previewSteps = await api.phonologyApplyWord(word);
    } catch (e) {
      error = String(e);
    }
  }

  async function runApply() {
    if (!applyTable) return;
    applyCount = null;
    try {
      applyCount = await api.phonologyApplyTable(applyTable);
      void load();
    } catch (e) {
      error = String(e);
    }
  }
</script>

<div class="phonology">
  <header class="phonology-bar">
    <span class="pane-title">{$t("phonology.title")}</span>
    <span class="muted">
      {$t("phonology.counts", {
        values: { consonants: consonantCount, vowels: vowelCount },
      })}
    </span>
    <span class="grow"></span>
    {#if status}<span class="muted">{status}</span>{/if}
    <button
      title={$t("phonology.clear")}
      disabled={phonemes.length === 0}
      onclick={clearInventory}
    >
      <Trash2 size={14} /> {$t("phonology.clear")}
    </button>
  </header>

  {#if error}<p class="error">{error}</p>{/if}

  <p class="muted hint">{$t("phonology.hint")}</p>

  <section class="ipa-section">
    <h2>{$t("phonology.consonants")}</h2>
    <div class="ipa-scroll">
      <table class="ipa-table">
        <thead>
          <tr>
            <th></th>
            {#each PLACES as place (place.id)}
              <th>{place.label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each CONSONANTS as row (row.manner)}
            <tr>
              <th scope="row">{row.manner}</th>
              {#each row.cells as cell, index (PLACES[index].id)}
                <td class="ipa-cell">
                  {#if cell.voiceless}
                    <button
                      class:active={chosen.has(cell.voiceless)}
                      onclick={() => toggle(cell.voiceless!, "consonant")}
                      >{cell.voiceless}</button
                    >
                  {/if}
                  {#if cell.voiced}
                    <button
                      class:active={chosen.has(cell.voiced)}
                      onclick={() => toggle(cell.voiced!, "consonant")}
                      >{cell.voiced}</button
                    >
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="ipa-section">
    <h2>{$t("phonology.vowels")}</h2>
    <table class="ipa-table vowels">
      <thead>
        <tr>
          <th></th>
          {#each BACKNESS as back (back.id)}
            <th>{back.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each VOWELS as row (row.height)}
          <tr>
            <th scope="row">{row.height}</th>
            {#each row.cells as cell, index (BACKNESS[index].id)}
              <td class="ipa-cell">
                {#if cell.unrounded}
                  <button
                    class:active={chosen.has(cell.unrounded)}
                    onclick={() => toggle(cell.unrounded!, "vowel")}
                    >{cell.unrounded}</button
                  >
                {/if}
                {#if cell.rounded}
                  <button
                    class:active={chosen.has(cell.rounded)}
                    onclick={() => toggle(cell.rounded!, "vowel")}
                    >{cell.rounded}</button
                  >
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="ipa-section">
    <h2>{$t("phonology.inventory")}</h2>
    {#if phonemes.length === 0}
      <p class="muted">{$t("phonology.empty")}</p>
    {:else}
      <div class="phoneme-chips">
        {#each phonemes as phoneme (phoneme.symbol)}
          <span class="phoneme-chip" class:other={phoneme.kind === "other"}>
            <span class="symbol">{phoneme.symbol}</span>
            <button
              title={$t("phonology.remove")}
              onclick={() => removePhoneme(phoneme.symbol)}
            >
              <X size={11} />
            </button>
          </span>
        {/each}
      </div>
    {/if}

    <div class="custom-row">
      <input
        placeholder={$t("phonology.symbolPlaceholder")}
        bind:value={customSymbol}
        onkeydown={(e) => e.key === "Enter" && addCustom()}
      />
      <select bind:value={customKind}>
        <option value="consonant">{$t("phonology.kindConsonant")}</option>
        <option value="vowel">{$t("phonology.kindVowel")}</option>
        <option value="other">{$t("phonology.kindOther")}</option>
      </select>
      <button onclick={addCustom}><Plus size={14} /> {$t("phonology.add")}</button>
    </div>
  </section>

  <section class="ipa-section">
    <h2>{$t("phonology.syllableShapes")}</h2>
    <p class="muted">{$t("phonology.syllableHint")}</p>
    <div class="phoneme-chips">
      {#each syllables as shape (shape)}
        <span class="phoneme-chip">
          <span class="symbol">{shape}</span>
          <button
            title={$t("phonology.remove")}
            onclick={() => removeSyllable(shape)}
          >
            <X size={11} />
          </button>
        </span>
      {/each}
    </div>
    <div class="custom-row">
      <input
        placeholder={$t("phonology.syllablePlaceholder")}
        bind:value={newSyllable}
        onkeydown={(e) => e.key === "Enter" && (addSyllable(newSyllable), (newSyllable = ""))}
      />
      <button
        onclick={() => {
          addSyllable(newSyllable);
          newSyllable = "";
        }}><Plus size={14} /> {$t("phonology.add")}</button
      >
    </div>
    <div class="preset-row">
      {#each SYLLABLE_PRESETS as preset (preset)}
        <button
          class="preset"
          disabled={syllables.includes(preset)}
          onclick={() => addSyllable(preset)}>{preset}</button
        >
      {/each}
    </div>
  </section>

  <section class="ipa-section">
    <h2>{$t("phonology.soundChanges")}</h2>
    <p class="muted">{$t("phonology.rulesHint")}</p>
    {#if rules.length === 0}
      <p class="muted">{$t("phonology.noRules")}</p>
    {:else}
      {#each rules as rule, index (index)}
        <div class="rule-row">
          <input
            placeholder="a"
            value={rule.from}
            oninput={(e) => updateRule(index, "from", e.currentTarget.value)}
          />
          <span class="muted">→</span>
          <input
            placeholder="b"
            value={rule.to}
            oninput={(e) => updateRule(index, "to", e.currentTarget.value)}
          />
          <span class="muted">/</span>
          <input
            class="grow"
            placeholder="_"
            value={rule.left ?? ""}
            oninput={(e) => updateRule(index, "left", e.currentTarget.value)}
          />
          <span class="muted">_</span>
          <input
            class="grow"
            placeholder=""
            value={rule.right ?? ""}
            oninput={(e) => updateRule(index, "right", e.currentTarget.value)}
          />
          <button title={$t("phonology.remove")} onclick={() => removeRule(index)}>
            <X size={13} />
          </button>
        </div>
      {/each}
    {/if}
    <div class="custom-row">
      <button onclick={addRule}><Plus size={14} /> {$t("phonology.addRule")}</button>
    </div>

    <div class="custom-row">
      <input
        placeholder={$t("phonology.previewPlaceholder")}
        bind:value={previewWord}
        onkeydown={(e) => e.key === "Enter" && runPreview()}
      />
      <button onclick={runPreview}>{$t("phonology.preview")}</button>
    </div>
    {#if previewSteps.length}
      <div class="rule-steps">
        {#each previewSteps as step, index (index)}
          <span class="rule-step">{step}</span>
          {#if index < previewSteps.length - 1}<span class="muted">→</span>{/if}
        {/each}
      </div>
    {/if}
  </section>

  <section class="ipa-section">
    <h2>{$t("phonology.apply")}</h2>
    <div class="custom-row">
      <select bind:value={applyTable}>
        <option value="">{$t("phonology.pickTable")}</option>
        {#each ui.tables as table (table.name)}
          <option value={table.name}>{table.name}</option>
        {/each}
      </select>
      <button onclick={runApply}>{$t("phonology.applyToTable")}</button>
    </div>
    {#if applyCount !== null}
      <p class="muted">{$t("phonology.applied", { values: { count: applyCount } })}</p>
    {/if}
  </section>
</div>
