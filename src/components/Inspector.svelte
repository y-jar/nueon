<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import {
    boolValue,
    displayValue,
    listValue,
    parseList,
    textValue,
  } from "../lib/dictionary";
  import { misspelledWords, spellSuggestions } from "../lib/spellcheck";
  import { ui, refreshTable } from "../lib/state.svelte";

  let draft = $state<api.WordEntry | null>(null);
  let candidates = $state<api.RelatedWord[]>([]);
  let activeId: string | null = null;
  let error = $state("");
  let definitionInput = $state("");
  let misspelled = $state<string[]>([]);
  let spellOptions = $state<Record<string, string[]>>({});
  let knownTags = $state<string[]>([]);

  // Rebuild the local draft only when the selected entry changes, so an
  // in-progress edit is not clobbered by a data-changed refetch.
  $effect(() => {
    const entry =
      ui.table?.entries.find((item) => item.id === ui.selectedEntry) ?? null;
    if (!entry) {
      draft = null;
      activeId = null;
      return;
    }
    if (entry.id !== activeId) {
      draft = structuredClone(entry);
      activeId = entry.id;
      candidates = [];
      definitionInput = listValue(entry.values["definition"]);
      misspelled = [];
      spellOptions = {};
      api
        .parentCandidates(entry.id)
        .then((value) => (candidates = value))
        .catch(() => (candidates = []));
    }
  });

  $effect(() => {
    if (ui.root) {
      api
        .knownTagNames()
        .then((names) => (knownTags = names))
        .catch(() => {});
    } else {
      knownTags = [];
    }
  });

  const fieldTags = $derived(
    (ui.table?.tags ?? []).filter(
      (tag) =>
        tag.name !== "wordname" &&
        tag.name !== "parent" &&
        tag.name !== "definition",
    ),
  );

  const RESERVED = ["wordname", "parent", "definition"];

  // Known tags from other tables that can be attached to this word. Adding one
  // declares it as a Boolean column in the current table.
  const attachableTags = $derived(
    knownTags.filter(
      (name) =>
        !RESERVED.includes(name) &&
        !(ui.table?.tags ?? []).some((tag) => tag.name === name),
    ),
  );

  function parentIds(entry: api.WordEntry): string[] {
    const value = entry.values["parent"];
    if (!value) return [];
    if (value.type === "references") return value.value;
    if (value.type === "reference") return [value.value];
    return [];
  }

  async function save() {
    if (!draft || !ui.currentTable) return;
    await api.saveWordEntry(ui.currentTable, draft);
    error = "";
  }

  async function setWordname(value: string) {
    if (!draft) return;
    draft = { ...draft, wordname: value };
    await save();
  }

  async function setField(tag: string, value: api.FieldValue) {
    if (!draft) return;
    draft = { ...draft, values: { ...draft.values, [tag]: value } };
    await save();
  }

  async function dropField(tag: string) {
    if (!draft) return;
    const values = { ...draft.values };
    delete values[tag];
    draft = { ...draft, values };
    await save();
  }

  async function setDefinition(input: string) {
    if (!draft) return;
    const senses = parseList(input);
    const values = { ...draft.values };
    if (senses.length) {
      values["definition"] = { type: "tag_list", value: senses };
    } else {
      delete values["definition"];
    }
    draft = { ...draft, values };
    await save();
  }

  async function commitDefinition() {
    await setDefinition(definitionInput);
    const words = await misspelledWords(definitionInput);
    misspelled = words;
    const options: Record<string, string[]> = {};
    for (const word of words) {
      options[word] = await spellSuggestions(word);
    }
    spellOptions = options;
  }

  async function applySuggestion(from: string, to: string) {
    definitionInput = definitionInput.split(from).join(to);
    misspelled = misspelled.filter((word) => word !== from);
    await commitDefinition();
  }

  async function attachTag(name: string) {
    if (!draft || !ui.currentTable || !name) return;
    await api.addTag(ui.currentTable, name, "boolean");
    await refreshTable();
    await setField(name, { type: "boolean", value: true });
  }

  async function addParent(parent: api.RelatedWord) {
    if (!draft || !ui.currentTable) return;
    const ok = await api.setParent(ui.currentTable, draft.id, parent.id);
    if (!ok) {
      error = $t("inspector.cannotAddParent");
      return;
    }
    error = "";
    const ids = parentIds(draft);
    if (!ids.includes(parent.id)) ids.push(parent.id);
    draft = {
      ...draft,
      values: { ...draft.values, parent: { type: "references", value: ids } },
    };
    candidates = await api.parentCandidates(draft.id);
  }

  async function dropParent(id: string) {
    if (!draft || !ui.currentTable) return;
    await api.removeParent(ui.currentTable, draft.id, id);
    const ids = parentIds(draft).filter((value) => value !== id);
    const values = { ...draft.values };
    if (ids.length) values["parent"] = { type: "references", value: ids };
    else delete values["parent"];
    draft = { ...draft, values };
    candidates = await api.parentCandidates(draft.id);
  }
</script>

<aside class="inspector">
  <div class="pane-title">{$t("inspector.title")}</div>
  {#if draft && ui.view === "dictionary"}
    <label class="field"
      >{$t("inspector.wordname")}
      <input
        value={draft.wordname}
        onblur={(e) => setWordname(e.currentTarget.value)}
      />
    </label>

    <label class="field"
      >{$t("inspector.definition")}
      <input
        bind:value={definitionInput}
        onblur={commitDefinition}
      />
    </label>

    {#if misspelled.length}
      <div class="spelling">
        <p class="error">
          {$t("inspector.spelling", {
            values: { words: misspelled.join(", ") },
          })}
        </p>
        {#each misspelled as word (word)}
          <div class="row">
            <span class="muted">{word}</span>
            {#each spellOptions[word] ?? [] as option (option)}
              <button class="chip" onclick={() => applySuggestion(word, option)}
                >{option}</button
              >
            {/each}
          </div>
        {/each}
      </div>
    {/if}

    {#if fieldTags.length}
      <div class="section-title">{$t("inspector.fields")}</div>
      {#each fieldTags as tag (tag.name)}
        <label class="field"
          >{tag.name}
          {#if tag.kind === "text"}
            <input
              value={textValue(draft.values[tag.name])}
              onblur={(e) =>
                setField(tag.name, {
                  type: "text",
                  value: e.currentTarget.value,
                })}
            />
          {:else if tag.kind === "boolean"}
            <input
              type="checkbox"
              checked={boolValue(draft.values[tag.name])}
              onchange={(e) =>
                setField(tag.name, {
                  type: "boolean",
                  value: e.currentTarget.checked,
                })}
            />
          {:else if tag.kind === "tag_list"}
            <input
              value={listValue(draft.values[tag.name])}
              onblur={(e) =>
                setField(tag.name, {
                  type: "tag_list",
                  value: parseList(e.currentTarget.value),
                })}
            />
          {:else}
            <span class="muted"
              >{displayValue(draft.values[tag.name]) || "—"}</span
            >
          {/if}
          {#if draft.values[tag.name]}
            <button
              title={$t("grid.removeTag")}
              onclick={() => dropField(tag.name)}>✕</button
            >
          {/if}
        </label>
      {/each}
    {/if}

    {#if attachableTags.length}
      <select
        onchange={(e) => {
          const value = e.currentTarget.value;
          if (value) attachTag(value);
          e.currentTarget.value = "";
        }}
      >
        <option value="">{$t("inspector.addField")}</option>
        {#each attachableTags as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
    {/if}

    <div class="section-title">{$t("inspector.parents")}</div>
    <ul class="parents">
      {#each parentIds(draft) as id (id)}
        <li>
          <button class="link" onclick={() => (ui.selectedEntry = id)}>
            {ui.nameById[id] ?? "?"}
          </button>
          <button onclick={() => dropParent(id)}>✕</button>
        </li>
      {/each}
    </ul>
    <select
      onchange={(e) => {
        const value = e.currentTarget.value;
        if (value) {
          addParent({
            id: value,
            wordname: ui.nameById[value] ?? "",
            table: "",
          });
        }
        e.currentTarget.value = "";
      }}
    >
      <option value="">{$t("inspector.addParent")}</option>
      {#each candidates as candidate (candidate.id)}
        <option value={candidate.id}
          >{candidate.wordname} · {candidate.table}</option
        >
      {/each}
    </select>
    {#if error}<p class="error">{error}</p>{/if}
  {:else}
    <p class="muted">{$t("inspector.selectWord")}</p>
  {/if}
</aside>
