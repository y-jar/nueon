<!-- Settings content: language, tables, keybinds. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { open } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { exportProfileDialog } from "../lib/exports";
  import {
    ui,
    openSetupWizard,
    closeSettings,
    setActivity,
    clearSuppressedConfirms,
    setKeybind,
    resetKeybinds,
  } from "../lib/state.svelte";
  import KeybindCaptureModal from "./KeybindCaptureModal.svelte";
  import {
    pluralEnding,
    rebuildPhonemes,
    setPluralEnding,
    splitSoundClasses,
  } from "../lib/configEdit";
  import {
    KEYBIND_GROUPS,
    formatKeys,
    resolveKeybinds,
  } from "../lib/keybindings";

  const TABS = [
    { id: "language", labelKey: "settings.language" },
    { id: "grammar", labelKey: "settings.grammar" },
    { id: "tables", labelKey: "settings.tables" },
    { id: "linting", labelKey: "settings.lintingTranslator" },
    { id: "keybinds", labelKey: "keybinds.title" },
    { id: "profile", labelKey: "settings.profile" },
  ] as const;

  let tab = $state<(typeof TABS)[number]["id"]>("language");
  /** Command id whose shortcut is being captured, if any. */
  let captureId = $state<string | null>(null);
  const resolved = $derived(resolveKeybinds(ui.keybinds));

  let language = $state<api.LanguageConfig>({
    name: "",
    author: "",
    description: "",
    script: "",
    direction: "ltr",
  });
  let rules = $state<api.GrammarRule[]>([]);
  let tableRoles = $state<Record<string, api.TableRoleConfig>>({});
  let phonology = $state<api.PhonologyConfig>({ phonemes: [], syllables: [], rules: [] });
  let morphology = $state<api.Morphology>({ features: [], paradigms: [] });
  let classInfo = $state<api.ClassColumnInfo | null>(null);
  let consonants = $state("");
  let vowels = $state("");
  let pluralSurface = $state("");
  let pluralKind = $state<api.AffixKind>("suffix");
  let status = $state("");
  let error = $state("");

  onMount(load);

  async function load() {
    try {
      language = await api.languageGet();
      rules = (await api.grammarGet()).rules;
      tableRoles = await api.tableRolesGet();
      phonology = await api.phonologyGet();
      morphology = await api.translationMorphology();
      classInfo = await api.classColumnGet();
      const split = splitSoundClasses(phonology.phonemes);
      consonants = split.consonants;
      vowels = split.vowels;
      const row = pluralEnding(morphology);
      pluralSurface = row?.surface ?? "";
      pluralKind = row?.kind ?? "suffix";
      applyDirection();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  // -- linting & translator ------------------------------------------------

  let soundTimer: ReturnType<typeof setTimeout> | undefined;
  let pluralTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleSaveSounds() {
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = setTimeout(() => void saveSounds(), 400);
  }

  async function saveSounds() {
    const phonemes = rebuildPhonemes(
      consonants,
      vowels,
      phonology.phonemes.filter((phoneme) => phoneme.kind === "other"),
    );
    try {
      await api.phonologySet({
        phonemes,
        syllables: phonology.syllables,
        rules: phonology.rules,
      });
      phonology = { phonemes, syllables: phonology.syllables, rules: phonology.rules };
      // Let the Phonology tab reload from the new config.
      ui.phonologyRevision += 1;
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function scheduleSavePlural() {
    if (pluralTimer) clearTimeout(pluralTimer);
    pluralTimer = setTimeout(() => void savePlural(), 400);
  }

  async function savePlural() {
    const next = setPluralEnding(morphology, pluralSurface, pluralKind);
    try {
      await api.setTranslationMorphology(next);
      morphology = next;
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  /** Strip a leading '#' from the class column's values across all tables. */
  async function cleanClassValues() {
    try {
      const count = await api.normalizeClassValues(classInfo?.resolved ?? null);
      status = $t("settings.cleanedClassValues", { values: { count } });
      error = "";
      await load();
    } catch (e) {
      error = String(e);
    }
  }

  /** Choose which column holds each word's class (empty = auto-detect). */
  async function setClassColumn(value: string) {
    const next: api.Morphology = {
      ...morphology,
      class_column: value || null,
    };
    try {
      await api.setTranslationMorphology(next);
      morphology = next;
      classInfo = await api.classColumnGet();
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  const PROFILE_FILTER = [{ name: "Nueon profile", extensions: ["json"] }];

  async function exportProfile() {
    try {
      if (!(await exportProfileDialog())) return;
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function importProfile() {
    const path = await open({ multiple: false, filters: PROFILE_FILTER });
    if (!path || Array.isArray(path)) return;
    try {
      await api.profileImport(path);
      await load();
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function roleOf(table: string): api.TableRoleConfig {
    return (
      tableRoles[table] ?? { role: "vocab", trigger: null, surface: null }
    );
  }

  async function setRole(
    table: string,
    role: api.TableRole,
    trigger: string | null = null,
    surface: string | null = null,
  ) {
    try {
      await api.setTableRole(table, role, trigger, surface);
      tableRoles = {
        ...tableRoles,
        [table]: { role, trigger, surface },
      };
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function applyDirection() {
    if (typeof document !== "undefined") {
      document.documentElement.dir = language.direction;
    }
  }

  async function saveLanguage() {
    try {
      await api.languageSet({ ...language });
      applyDirection();
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function saveGrammar() {
    try {
      await api.grammarSet({ rules });
      status = $t("settings.saved");
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function addRule() {
    rules = [
      ...rules,
      { name: $t("settings.untitledRule"), description: "", slots: [] },
    ];
  }

  function removeRule(index: number) {
    rules = rules.filter((_, i) => i !== index);
    saveGrammar();
  }

  function updateRule(
    index: number,
    patch: Partial<api.GrammarRule>,
  ) {
    rules = rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
  }

  function formatSlots(slots: api.ClauseSlot[]): string {
    return slots
      .map((slot) => {
        switch (slot.kind) {
          case "required_tag":
            return `#${slot.tag}`;
          case "pos":
            return `%${slot.class}`;
          case "literal":
            return `"${slot.text}"`;
          case "wildcard":
            return "*";
          case "spacer":
            return slot.text ? `␣${slot.text}` : "␣";
        }
      })
      .join(" ");
  }

  function parseSlot(token: string): api.ClauseSlot {
    if (token === "*") return { kind: "wildcard" };
    if (token.startsWith("#")) {
      return { kind: "required_tag", tag: token.slice(1) };
    }
    if (token.startsWith("%") && token.length > 1) {
      return { kind: "pos", class: token.slice(1) };
    }
    if (token.startsWith("␣")) {
      const text = token.slice(1);
      return text ? { kind: "spacer", text } : { kind: "spacer" };
    }
    if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
      return { kind: "literal", text: token.slice(1, -1) };
    }
    return { kind: "literal", text: token };
  }

  function parseSlots(text: string): api.ClauseSlot[] {
    return text
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map(parseSlot);
  }
</script>

<div class="settings">
  <nav class="settings-nav">
    {#each TABS as item (item.id)}
      <button class:active={tab === item.id} onclick={() => (tab = item.id)}
        >{$t(item.labelKey)}</button
      >
    {/each}
    <span class="grow"></span>
    <button
      onclick={() => {
        closeSettings();
        openSetupWizard();
      }}>{$t("settings.runSetup")}</button
    >
  </nav>

  <div class="settings-content">
    {#if tab === "language"}
      <div class="pane-title">{$t("settings.language")}</div>
      <label class="field"
        >{$t("settings.name")}
        <input bind:value={language.name} onblur={saveLanguage} />
      </label>
      <label class="field"
        >{$t("settings.author")}
        <input bind:value={language.author} onblur={saveLanguage} />
      </label>
      <label class="field"
        >{$t("settings.script")}
        <input bind:value={language.script} onblur={saveLanguage} />
      </label>
      <label class="field"
        >{$t("settings.description")}
        <input bind:value={language.description} onblur={saveLanguage} />
      </label>
      <label class="field"
        >{$t("settings.direction")}
        <select bind:value={language.direction} onchange={saveLanguage}>
          <option value="ltr">{$t("settings.ltr")}</option>
          <option value="rtl">{$t("settings.rtl")}</option>
        </select>
      </label>
    {:else if tab === "grammar"}
      <div class="pane-title">{$t("settings.grammar")}</div>
      <p class="muted">{$t("settings.grammarHint")}</p>
      {#each rules as rule, index (index)}
        <div class="rule">
          <div class="row">
            <input
              placeholder={$t("settings.ruleName")}
              value={rule.name}
              onblur={(e) => {
                updateRule(index, { name: e.currentTarget.value });
                saveGrammar();
              }}
            />
            <button onclick={() => removeRule(index)}>✕</button>
          </div>
          <input
            placeholder={$t("settings.ruleDescription")}
            value={rule.description}
            onblur={(e) => {
              updateRule(index, { description: e.currentTarget.value });
              saveGrammar();
            }}
          />
          <input
            class="mono"
            placeholder={$t("settings.slotsPlaceholder")}
            value={formatSlots(rule.slots)}
            onblur={(e) => {
              updateRule(index, { slots: parseSlots(e.currentTarget.value) });
              saveGrammar();
            }}
          />
        </div>
      {/each}
      <button onclick={addRule}>{$t("settings.addRule")}</button>
    {:else if tab === "tables"}
      <div class="pane-title">{$t("settings.tables")}</div>
      <p class="muted">{$t("settings.tablesHint")}</p>
      {#each ui.tables as table (table.name)}
        {@const config = roleOf(table.name)}
        {@const textColumns = table.tags
          .filter((tag) => tag.kind === "text")
          .map((tag) => tag.name)}
        <div class="rule">
          <div class="row">
            <span class="grow">{table.name}</span>
            <select
              value={config.role}
              onchange={(e) =>
                setRole(table.name, e.currentTarget.value as api.TableRole)}
            >
              <option value="vocab">{$t("settings.roleVocab")}</option>
              <option value="fixes">{$t("settings.roleFixes")}</option>
            </select>
          </div>
          {#if config.role === "fixes"}
            <label class="field"
              >{$t("settings.triggerColumn")}
              <select
                value={config.trigger ?? ""}
                onchange={(e) =>
                  setRole(
                    table.name,
                    "fixes",
                    e.currentTarget.value || null,
                    config.surface ?? null,
                  )}
              >
                <option value="">—</option>
                {#each textColumns as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
            <label class="field"
              >{$t("settings.surfaceColumn")}
              <select
                value={config.surface ?? ""}
                onchange={(e) =>
                  setRole(
                    table.name,
                    "fixes",
                    config.trigger ?? null,
                    e.currentTarget.value || null,
                  )}
              >
                <option value="">{$t("settings.wordnameDefault")}</option>
                {#each textColumns as name (name)}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/each}
    {:else if tab === "linting"}
      <section class="group">
        <div class="pane-title">{$t("settings.lintingTranslator")}</div>
        <p class="muted">{$t("settings.lintingHint")}</p>

        <p class="muted">{$t("settings.soundClassesHint")}</p>
        <div class="row">
          <label class="field grow"
            >{$t("settings.consonants")}
            <input
              value={consonants}
              oninput={(e) => {
                consonants = e.currentTarget.value;
                scheduleSaveSounds();
              }}
            />
          </label>
          <label class="field grow"
            >{$t("settings.vowels")}
            <input
              value={vowels}
              oninput={(e) => {
                vowels = e.currentTarget.value;
                scheduleSaveSounds();
              }}
            />
          </label>
        </div>

        <div class="field">
          {$t("settings.shapes")}
          <div class="phoneme-chips">
            {#each phonology.syllables as shape (shape)}
              <span class="phoneme-chip"><span class="symbol">{shape}</span></span>
            {:else}
              <span class="muted">{$t("phonology.empty")}</span>
            {/each}
          </div>
        </div>
        <p class="muted">{$t("settings.shapesHint")}</p>
        <button
          onclick={() => {
            closeSettings();
            setActivity("phonology");
          }}>{$t("settings.openInventory")}</button
        >

        <div class="field">
          {$t("settings.pluralEnding")}
          <div class="row">
            <select bind:value={pluralKind} onchange={savePlural}>
              <option value="suffix">{$t("translation.suffix")}</option>
              <option value="prefix">{$t("translation.prefix")}</option>
            </select>
            <input
              class="grow"
              placeholder={$t("translation.ending")}
              value={pluralSurface}
              oninput={(e) => {
                pluralSurface = e.currentTarget.value;
                scheduleSavePlural();
              }}
            />
          </div>
        </div>
        <p class="muted">{$t("settings.pluralHint")}</p>

        <div class="field class-column">
          {$t("settings.classColumn")}
          <div class="row">
            <select
              value={morphology.class_column ?? ""}
              onchange={(e) => setClassColumn(e.currentTarget.value)}
            >
              <option value="">{$t("settings.classColumnAuto")}</option>
              {#each classInfo?.candidates ?? [] as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
            <span class="muted"
              >{$t("settings.classColumnResolved", {
                values: { column: classInfo?.resolved ?? "" },
              })}</span
            >
            <button class="clean-class" onclick={cleanClassValues}
              >{$t("settings.cleanClassValues")}</button
            >
          </div>
        </div>
        <p class="muted">{$t("settings.classColumnHint")}</p>
      </section>
    {:else if tab === "keybinds"}
      <div class="pane-title">{$t("keybinds.title")}</div>
      <p class="muted">{$t("keybinds.hint")}</p>
      {#each KEYBIND_GROUPS as group (group.titleKey)}
        <div class="section-title">{$t(group.titleKey)}</div>
        <ul class="keybind-list">
          {#each group.bindings as def (def.id)}
            <li>
              <span class="keys mono"
                >{resolved[def.id]
                  ? formatKeys(resolved[def.id]!)
                  : $t("keybinds.unbound")}</span
              >
              <span class="grow"
                >{$t(
                  def.labelKey,
                  def.values ? { values: def.values } : undefined,
                )}</span
              >
              <button onclick={() => (captureId = def.id)}
                >{$t("keybinds.edit")}</button
              >
              {#if def.id in ui.keybinds}
                <button onclick={() => void setKeybind(def.id, null)}
                  >{$t("keybinds.reset")}</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/each}
      <p class="muted">{$t("keybinds.fixed")}</p>
      <button
        disabled={Object.keys(ui.keybinds).length === 0}
        onclick={() => void resetKeybinds()}>{$t("keybinds.resetAll")}</button
      >
    {:else}
      <div class="pane-title">{$t("settings.profile")}</div>
      <p class="muted">{$t("settings.profileHint")}</p>
      <div class="row">
        <button onclick={exportProfile}>{$t("settings.exportProfile")}</button>
        <button onclick={importProfile}>{$t("settings.importProfile")}</button>
      </div>
      <button
        disabled={ui.suppressedConfirms.length === 0}
        onclick={() => clearSuppressedConfirms()}
        >{$t("settings.resetConfirms")}{ui.suppressedConfirms.length
          ? ` (${ui.suppressedConfirms.length})`
          : ""}</button
      >
    {/if}

    {#if status}<p class="muted">{status}</p>{/if}
    {#if error}<p class="error">{error}</p>{/if}
  </div>

  {#if captureId}
    <KeybindCaptureModal
      id={captureId}
      current={resolved[captureId] ?? null}
      {resolved}
      onSave={(key) => {
        void setKeybind(captureId!, key);
        captureId = null;
      }}
      onReset={() => {
        void setKeybind(captureId!, null);
        captureId = null;
      }}
      onClose={() => (captureId = null)}
    />
  {/if}
</div>
