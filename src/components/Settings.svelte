<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { ui, openSetupWizard, closeSettings } from "../lib/state.svelte";

  let language = $state<api.LanguageConfig>({
    name: "",
    author: "",
    description: "",
    script: "",
    direction: "ltr",
  });
  let rules = $state<api.GrammarRule[]>([]);
  let tableRoles = $state<Record<string, api.TableRoleConfig>>({});
  let status = $state("");
  let error = $state("");

  onMount(load);

  async function load() {
    try {
      language = await api.languageGet();
      rules = (await api.grammarGet()).rules;
      tableRoles = await api.tableRolesGet();
      applyDirection();
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  const PROFILE_FILTER = [{ name: "Nueon profile", extensions: ["json"] }];

  async function exportProfile() {
    const path = await save({
      defaultPath: "profile.nueon.json",
      filters: PROFILE_FILTER,
    });
    if (!path) return;
    try {
      await api.profileExport(path);
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
          onchange={(e) => setRole(table.name, e.currentTarget.value as api.TableRole)}
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

  <div class="pane-title">{$t("settings.profile")}</div>
  <p class="muted">{$t("settings.profileHint")}</p>
  <div class="row">
    <button onclick={exportProfile}>{$t("settings.exportProfile")}</button>
    <button onclick={importProfile}>{$t("settings.importProfile")}</button>
  </div>

  <button
    onclick={() => {
      closeSettings();
      openSetupWizard();
    }}>{$t("settings.runSetup")}</button
  >

  {#if status}<p class="muted">{status}</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>
