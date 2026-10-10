<!-- One dictionary grid cell renderer. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Check } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { boolValue, displayValue, textValue } from "../lib/dictionary";
  import PillCell from "./PillCell.svelte";
  import SuggestInput from "./SuggestInput.svelte";

  interface Props {
    /** The column's tag. */
    tag: api.TagDef;
    /** The row's entry, or `null` for the ghost (quick-add) row. */
    entry: api.WordEntry | null;
    ghostValues: Record<string, api.FieldValue>;
    suggestions: string[];
    relationOptions: { id: string; label: string }[];
    nameById: Record<string, string>;
    onCellKey: (event: KeyboardEvent, original: string) => void;
    commitText: (entry: api.WordEntry, tag: string, value: string) => void;
    commitBool: (entry: api.WordEntry, tag: string, value: boolean) => void;
    addToList: (entry: api.WordEntry, tag: string, text: string) => void;
    removeFromList: (entry: api.WordEntry, tag: string, id: string) => void;
    addRelation: (entry: api.WordEntry, tag: string, label: string) => void;
    removeRelation: (entry: api.WordEntry, tag: string, id: string) => void;
    setGhost: (tag: string, value: api.FieldValue | null) => void;
    createGhost: () => void;
    optionId: (label: string) => string | null;
  }

  let {
    tag,
    entry,
    ghostValues,
    suggestions,
    relationOptions,
    nameById,
    onCellKey,
    commitText,
    commitBool,
    addToList,
    removeFromList,
    addRelation,
    removeRelation,
    setGhost,
    createGhost,
    optionId,
  }: Props = $props();

  const placeholder = "—";

  function listValues(word: api.WordEntry, name: string): string[] {
    const value = word.values[name];
    return value && value.type === "tag_list" ? value.value : [];
  }

  function refValues(word: api.WordEntry, name: string): string[] {
    const value = word.values[name];
    if (!value) return [];
    if (value.type === "references") return value.value;
    if (value.type === "reference") return [value.value];
    return [];
  }

  function ghostList(name: string): string[] {
    const value = ghostValues[name];
    return value && value.type === "tag_list" ? value.value : [];
  }

  function ghostRefs(name: string): string[] {
    const value = ghostValues[name];
    return value && value.type === "references" ? value.value : [];
  }

  const inputType = (format?: api.TagFormat) =>
    format === "date" ? "date" : format === "measurement" ? "number" : "text";
</script>

{#if tag.kind === "text"}
  {#if entry}
    {#if tag.format === "multiline"}
      <textarea
        rows="2"
        placeholder={placeholder}
        value={textValue(entry.values[tag.name])}
        onkeydown={(e) => onCellKey(e, textValue(entry.values[tag.name]))}
        onblur={(e) => commitText(entry, tag.name, e.currentTarget.value)}
      ></textarea>
    {:else if tag.suggest}
      <SuggestInput
        type={inputType(tag.format)}
        placeholder={placeholder}
        value={textValue(entry.values[tag.name])}
        suggestions={suggestions}
        onCommit={(value) => commitText(entry, tag.name, value)}
      />
    {:else}
      <input
        type={inputType(tag.format)}
        placeholder={placeholder}
        value={textValue(entry.values[tag.name])}
        onkeydown={(e) => onCellKey(e, textValue(entry.values[tag.name]))}
        onblur={(e) => commitText(entry, tag.name, e.currentTarget.value)}
      />
    {/if}
  {:else}
    <input
      type={inputType(tag.format)}
      placeholder={placeholder}
      value={textValue(ghostValues[tag.name])}
      oninput={(e) =>
        setGhost(
          tag.name,
          e.currentTarget.value
            ? { type: "text", value: e.currentTarget.value }
            : null,
        )}
      onkeydown={(e) => e.key === "Enter" && createGhost()}
    />
  {/if}
{:else if tag.kind === "boolean"}
  {#if entry}
    <button
      class="check-cell"
      class:on={boolValue(entry.values[tag.name])}
      onclick={() => commitBool(entry, tag.name, !boolValue(entry.values[tag.name]))}
    >
      {#if boolValue(entry.values[tag.name])}<Check size={14} />{/if}
    </button>
  {:else}
    <button
      class="check-cell"
      class:on={boolValue(ghostValues[tag.name])}
      onclick={() =>
        setGhost(
          tag.name,
          boolValue(ghostValues[tag.name])
            ? null
            : { type: "boolean", value: true },
        )}
    >
      {#if boolValue(ghostValues[tag.name])}<Check size={14} />{/if}
    </button>
  {/if}
{:else if tag.kind === "tag_list"}
  {#if entry}
    <PillCell
      pills={listValues(entry, tag.name).map((value) => ({
        id: value,
        label: value,
      }))}
      placeholder={$t("grid.addPill")}
      options={tag.suggest
        ? suggestions.map((value) => ({ id: value, label: value }))
        : []}
      onAdd={(text) => addToList(entry, tag.name, text)}
      onRemove={(id) => removeFromList(entry, tag.name, id)}
    />
  {:else}
    <PillCell
      pills={ghostList(tag.name).map((value) => ({ id: value, label: value }))}
      placeholder={$t("grid.addPill")}
      onAdd={(text) => {
        const items = ghostList(tag.name);
        if (!items.includes(text))
          setGhost(tag.name, { type: "tag_list", value: [...items, text] });
      }}
      onRemove={(id) =>
        setGhost(
          tag.name,
          ghostList(tag.name).length > 1
            ? {
                type: "tag_list",
                value: ghostList(tag.name).filter((item) => item !== id),
              }
            : null,
        )}
    />
  {/if}
{:else if tag.kind === "references" || tag.kind === "reference"}
  {#if entry}
    <PillCell
      pills={refValues(entry, tag.name).map((id) => ({
        id,
        label: nameById[id] ?? "?",
      }))}
      placeholder={$t("grid.addRelation")}
      options={relationOptions}
      onAdd={(label) => addRelation(entry, tag.name, label)}
      onRemove={(id) => removeRelation(entry, tag.name, id)}
    />
  {:else}
    <PillCell
      pills={ghostRefs(tag.name).map((id) => ({
        id,
        label: nameById[id] ?? "?",
      }))}
      placeholder={$t("grid.addRelation")}
      options={relationOptions}
      onAdd={(label) => {
        const id = optionId(label);
        const ids = ghostRefs(tag.name);
        if (id && !ids.includes(id))
          setGhost(tag.name, { type: "references", value: [...ids, id] });
      }}
      onRemove={(id) =>
        setGhost(
          tag.name,
          ghostRefs(tag.name).length > 1
            ? {
                type: "references",
                value: ghostRefs(tag.name).filter((item) => item !== id),
              }
            : null,
        )}
    />
  {/if}
{:else}
  {entry ? (displayValue(entry.values[tag.name]) || "—") : ""}
{/if}
