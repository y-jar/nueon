<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";

  let language = $state<api.LanguageConfig>({
    name: "",
    author: "",
    description: "",
    script: "",
    direction: "ltr",
  });
  let rules = $state<api.GrammarRule[]>([]);
  let status = $state("");
  let error = $state("");

  onMount(load);

  async function load() {
    try {
      language = await api.languageGet();
      rules = (await api.grammarGet()).rules;
      applyDirection();
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

  {#if status}<p class="muted">{status}</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>
