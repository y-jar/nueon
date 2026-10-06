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
  import { ui, activeDoc, refreshTable } from "../lib/state.svelte";
  import DerivationGraph from "./DerivationGraph.svelte";

  let draft = $state<api.WordEntry | null>(null);
  let activeId: string | null = null;
  let definitionInput = $state("");
  let misspelled = $state<string[]>([]);
  let spellOptions = $state<Record<string, string[]>>({});
  let knownTags = $state<string[]>([]);

  // Rebuild the local draft only when the selected entry changes, so an
  // in-progress edit is not clobbered by a data-changed refetch.
  $effect(() => {
    const entry =
      activeDoc().table?.entries.find((item) => item.id === activeDoc().selectedEntry) ?? null;
    if (!entry) {
      draft = null;
      activeId = null;
      return;
    }
    if (entry.id !== activeId) {
      // `entry` is a live Svelte 5 `$state` proxy; some WebKit builds throw
      // `DataCloneError` on `structuredClone(entry)` for such proxies
      // (discovered via the stage-4 field-patch probe, not by inspection —
      // it silently left `draft` null forever, so the inspector could never
      // show a selected word at all). `$state.snapshot` is the supported way
      // to take a plain-data copy of reactive state.
      draft = $state.snapshot(entry);
      activeId = entry.id;
      definitionInput = listValue(entry.values["definition"]);
      misspelled = [];
      spellOptions = {};
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
    (activeDoc().table?.tags ?? []).filter(
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
        !(activeDoc().table?.tags ?? []).some((tag) => tag.name === name),
    ),
  );

  // Each of these patches one field against whatever is *currently* stored,
  // rather than sending the whole `draft` entry. `draft` itself is only a
  // local, optimistic mirror for the UI: since the Grid can be editing a
  // different field of this exact word at the same moment, sending the whole
  // draft would silently discard whatever the Grid just saved.

  async function setWordname(value: string) {
    const table = activeDoc().currentTable;
    if (!draft || !table) return;
    draft = { ...draft, wordname: value };
    await api.renameWord(table, draft.id, value);
  }

  async function setField(tag: string, value: api.FieldValue) {
    const table = activeDoc().currentTable;
    if (!draft || !table) return;
    draft = { ...draft, values: { ...draft.values, [tag]: value } };
    await api.setWordValue(table, draft.id, tag, value);
  }

  async function dropField(tag: string) {
    const table = activeDoc().currentTable;
    if (!draft || !table) return;
    const values = { ...draft.values };
    delete values[tag];
    draft = { ...draft, values };
    await api.setWordValue(table, draft.id, tag, null);
  }

  async function setDefinition(input: string) {
    const table = activeDoc().currentTable;
    if (!draft || !table) return;
    const senses = parseList(input);
    const values = { ...draft.values };
    if (senses.length) {
      values["definition"] = { type: "tag_list", value: senses };
    } else {
      delete values["definition"];
    }
    draft = { ...draft, values };
    await api.setWordDefinition(table, draft.id, senses);
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
    const table = activeDoc().currentTable;
    if (!draft || !table || !name) return;
    await api.addTag(table, name, "boolean");
    await refreshTable();
    await setField(name, { type: "boolean", value: true });
  }
</script>

<aside class="inspector">
  <div class="pane-title">{$t("inspector.title")}</div>
  {#if draft && activeDoc().view === "dictionary"}
    <label class="field"
      >{$t("inspector.wordname")}
      <input
        value={draft.wordname}
        onblur={(e) => setWordname(e.currentTarget.value)}
      />
    </label>

    <label class="field"
      >{$t("inspector.definition")}
      <input bind:value={definitionInput} onblur={commitDefinition} />
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

    <DerivationGraph id={draft.id} />
  {:else}
    <p class="muted">{$t("inspector.selectWord")}</p>
  {/if}
</aside>
