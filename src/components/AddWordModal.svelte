<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    X,
    Type,
    TextAlignStart,
    Calendar,
    Ruler,
    List,
    Link,
    Network,
    SquareCheck,
  } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { boolValue, textValue } from "../lib/dictionary";
  import { createWordWithValues } from "../lib/words";
  import PillCell from "./PillCell.svelte";
  import SuggestInput from "./SuggestInput.svelte";

  interface Option {
    id: string;
    label: string;
  }

  interface Props {
    table: string;
    /** The table's schema; every non-builtin tag becomes a property row. */
    tags: api.TagDef[];
    /** Existing words offered by relation / parent pickers. */
    options: Option[];
    nameById: Record<string, string>;
    /** Existing values per suggest-enabled column. */
    suggestions: Record<string, string[]>;
    onClose: () => void;
    onCreated: () => void | Promise<void>;
  }

  let {
    table,
    tags,
    options,
    nameById,
    suggestions,
    onClose,
    onCreated,
  }: Props = $props();

  const properties = $derived(
    tags.filter((tag) => tag.name !== "wordname" && tag.name !== "parent"),
  );

  let wordname = $state("");
  let values = $state<Record<string, api.FieldValue>>({});
  let parents = $state<string[]>([]);
  let error = $state("");
  let busy = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    nameInput?.focus();
  });

  function setValue(tag: string, value: api.FieldValue | null) {
    const next = { ...values };
    if (value) next[tag] = value;
    else delete next[tag];
    values = next;
  }

  function listOf(tag: string): string[] {
    const value = values[tag];
    return value && value.type === "tag_list" ? value.value : [];
  }

  function refsOf(tag: string): string[] {
    const value = values[tag];
    return value && value.type === "references" ? value.value : [];
  }

  function idForLabel(label: string): string | null {
    return options.find((option) => option.label === label)?.id ?? null;
  }

  function inputType(tag: api.TagDef): string {
    if (tag.format === "date") return "date";
    if (tag.format === "measurement") return "number";
    return "text";
  }

  async function submit() {
    const name = wordname.trim();
    if (!name) {
      error = $t("grid.wordnameRequired");
      nameInput?.focus();
      return;
    }
    busy = true;
    try {
      const result = await createWordWithValues(table, name, values, parents);
      if (!result.id) {
        error = $t("grid.createFailed");
        return;
      }
      await onCreated();
      onClose();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-overlay"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="modal add-word-modal"
    role="dialog"
    aria-modal="true"
    aria-label={$t("grid.addWord")}
  >
    <div class="modal-head">
      <span class="pane-title">{$t("grid.addWord")} · {table}</span>
      <button onclick={onClose} title={$t("grid.cancel")}><X size={16} /></button>
    </div>

    <div class="modal-body prop-list">
      <div class="prop-row">
        <span class="prop-name"><Type size={14} /> wordname</span>
        <div class="prop-value">
          <input
            bind:this={nameInput}
            placeholder={$t("grid.newWord")}
            bind:value={wordname}
            onkeydown={(e) => e.key === "Enter" && submit()}
          />
        </div>
      </div>

      <div class="prop-row">
        <span class="prop-name"><Network size={14} /> parent</span>
        <div class="prop-value">
          <PillCell
            pills={parents.map((id) => ({ id, label: nameById[id] ?? "?" }))}
            placeholder={$t("grid.addParent")}
            {options}
            onAdd={(label) => {
              const id = idForLabel(label);
              if (id && !parents.includes(id)) parents = [...parents, id];
            }}
            onRemove={(id) => (parents = parents.filter((p) => p !== id))}
          />
        </div>
      </div>

      {#each properties as tag (tag.name)}
        <div class="prop-row">
          <span class="prop-name">
            {#if tag.kind === "boolean"}
              <SquareCheck size={14} />
            {:else if tag.kind === "tag_list"}
              <List size={14} />
            {:else if tag.kind === "references" || tag.kind === "reference"}
              <Link size={14} />
            {:else if tag.format === "multiline"}
              <TextAlignStart size={14} />
            {:else if tag.format === "date"}
              <Calendar size={14} />
            {:else if tag.format === "measurement"}
              <Ruler size={14} />
            {:else}
              <Type size={14} />
            {/if}
            {tag.name}
          </span>
          <div class="prop-value">
            {#if tag.kind === "text"}
              {#if tag.format === "multiline"}
                <textarea
                  rows="3"
                  value={textValue(values[tag.name])}
                  oninput={(e) =>
                    setValue(
                      tag.name,
                      e.currentTarget.value
                        ? { type: "text", value: e.currentTarget.value }
                        : null,
                    )}
                ></textarea>
              {:else if tag.suggest}
                <SuggestInput
                  type={inputType(tag)}
                  value={textValue(values[tag.name])}
                  suggestions={suggestions[tag.name] ?? []}
                  onInput={(value) =>
                    setValue(
                      tag.name,
                      value ? { type: "text", value } : null,
                    )}
                  onCommit={(value) =>
                    setValue(
                      tag.name,
                      value ? { type: "text", value } : null,
                    )}
                  onEnter={submit}
                />
              {:else}
                <input
                  type={inputType(tag)}
                  value={textValue(values[tag.name])}
                  oninput={(e) =>
                    setValue(
                      tag.name,
                      e.currentTarget.value
                        ? { type: "text", value: e.currentTarget.value }
                        : null,
                    )}
                  onkeydown={(e) => e.key === "Enter" && submit()}
                />
              {/if}
            {:else if tag.kind === "boolean"}
              <button
                type="button"
                class="check-cell"
                class:on={boolValue(values[tag.name])}
                onclick={() =>
                  setValue(
                    tag.name,
                    boolValue(values[tag.name])
                      ? null
                      : { type: "boolean", value: true },
                  )}
              >
                {#if boolValue(values[tag.name])}
                  <SquareCheck size={14} />
                {/if}
              </button>
            {:else if tag.kind === "tag_list"}
              <PillCell
                pills={listOf(tag.name).map((v) => ({ id: v, label: v }))}
                placeholder={$t("grid.addPill")}
                options={tag.suggest
                  ? (suggestions[tag.name] ?? []).map((value) => ({
                      id: value,
                      label: value,
                    }))
                  : []}
                onAdd={(text) => {
                  const items = listOf(tag.name);
                  if (!items.includes(text))
                    setValue(tag.name, {
                      type: "tag_list",
                      value: [...items, text],
                    });
                }}
                onRemove={(id) => {
                  const items = listOf(tag.name).filter((v) => v !== id);
                  setValue(
                    tag.name,
                    items.length ? { type: "tag_list", value: items } : null,
                  );
                }}
              />
            {:else if tag.kind === "references" || tag.kind === "reference"}
              <PillCell
                pills={refsOf(tag.name).map((id) => ({
                  id,
                  label: nameById[id] ?? "?",
                }))}
                placeholder={$t("grid.addRelation")}
                {options}
                onAdd={(label) => {
                  const id = idForLabel(label);
                  const ids = refsOf(tag.name);
                  if (id && !ids.includes(id))
                    setValue(tag.name, {
                      type: "references",
                      value: [...ids, id],
                    });
                }}
                onRemove={(id) => {
                  const ids = refsOf(tag.name).filter((v) => v !== id);
                  setValue(
                    tag.name,
                    ids.length ? { type: "references", value: ids } : null,
                  );
                }}
              />
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <div class="modal-foot">
      {#if error}<span class="error grow">{error}</span>{:else}<span
          class="muted grow">{$t("grid.addWordHint")}</span
        >{/if}
      <button onclick={onClose}>{$t("grid.cancel")}</button>
      <button class="primary" disabled={busy} onclick={submit}>
        {$t("grid.add")}
      </button>
    </div>
  </div>
</div>
