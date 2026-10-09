<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../../lib/api";
  import { ui } from "../../lib/state.svelte";
  import { morphology as store } from "../../lib/morphology.svelte";

  interface Props {
    classId: string;
  }

  let { classId }: Props = $props();

  let grid = $state<api.ParadigmGrid | null>(null);
  let filterFeature = $state("");
  let filterValue = $state("");

  // Refetch when the class changes or the config is written (our own edits
  // bump `morphologyRevision`).
  $effect(() => {
    void classId;
    void ui.morphologyRevision;
    void load();
  });

  async function load() {
    try {
      grid = await api.paradigmGrid(classId);
    } catch (e) {
      store.error = String(e);
    }
  }

  function labelFor(featureId: string, valueId: string): string {
    if (valueId === "") return $t("morphology.unset");
    const feature = store.morphology.features.find((f) => f.id === featureId);
    return (
      feature?.values.find((value) => value.id === valueId)?.label ?? valueId
    );
  }

  const rows = $derived(
    (grid?.rows ?? []).filter(
      (row) =>
        !filterFeature || row.when[filterFeature] === filterValue,
    ),
  );

  const filterFeatureValues = $derived(
    filterFeature
      ? (store.morphology.features.find((f) => f.id === filterFeature)?.values ??
          [])
      : [],
  );

  const hidden = $derived(
    (grid?.total ?? 0) > (grid?.rows.length ?? 0)
      ? (grid?.total ?? 0) - (grid?.rows.length ?? 0)
      : 0,
  );

  function selectValue(cell: api.GridCell): string {
    if (!cell.defined) return "";
    if (cell.zero) return "__zero";
    if (cell.morpheme && typeof cell.morpheme === "object") {
      return `ref:${cell.morpheme.table}:${cell.morpheme.id}`;
    }
    return "__free";
  }

  function isFree(cell: api.GridCell): boolean {
    return cell.defined && !cell.zero && (cell.morpheme ?? null) === null;
  }

  async function onCellChange(
    row: api.GridRow,
    cell: api.GridCell,
    value: string,
  ) {
    const slot = cell.slot;
    if (value === "") return;
    if (value === "__zero") {
      await store.setCell(classId, slot, row.when, { zero: true });
    } else if (value === "__free") {
      await store.setCell(classId, slot, row.when, {
        surface: cell.surface,
        kind: cell.kind,
      });
    } else if (value.startsWith("ref:")) {
      const [, table, id] = value.split(":");
      await store.setCell(classId, slot, row.when, { morpheme: { table, id } });
    }
  }

  async function onSurfaceInput(
    row: api.GridRow,
    cell: api.GridCell,
    surface: string,
  ) {
    await store.setCell(classId, cell.slot, row.when, {
      surface,
      kind: cell.kind,
    });
  }
</script>

<div class="paradigm-grid">
  {#if store.morphology.features.length}
    <div class="grid-filter">
      <span class="muted">{$t("morphology.filterBy")}</span>
      <select
        value={filterFeature}
        onchange={(e) => {
          filterFeature = e.currentTarget.value;
          filterValue = "";
        }}
      >
        <option value="">{$t("morphology.all")}</option>
        {#each store.morphology.features as feature (feature.id)}
          <option value={feature.id}>{feature.label}</option>
        {/each}
      </select>
      {#if filterFeature}
        <select bind:value={filterValue}>
          {#each filterFeatureValues as value (value.id)}
            <option value={value.id}>{value.label}</option>
          {/each}
        </select>
      {/if}
    </div>
  {/if}

  {#if !grid || grid.rows.length === 0}
    <p class="muted">{$t("morphology.noEndings")}</p>
  {:else}
    <div class="paradigm-grid-scroll">
      <table class="paradigm-table">
        <thead>
          <tr>
            <th></th>
            {#each grid.slots as slot (slot ?? "")}
              <th>{slot ?? $t("morphology.defaultSlot")}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row (JSON.stringify(row.when))}
            <tr>
              <th class="row-label">
                {#each Object.entries(row.when) as [feature, value] (feature)}
                  <span class="badge"
                    >{labelFor(feature, value)}</span
                  >
                {/each}
              </th>
              {#each row.cells as cell (cell.slot ?? "")}
                <td
                  class:gap={!cell.defined}
                  class:ambiguous={cell.ambiguous}
                >
                  <select
                    class="cell-select"
                    value={selectValue(cell)}
                    onchange={(e) =>
                      onCellChange(row, cell, e.currentTarget.value)}
                  >
                    <option value="">—</option>
                    <option value="__free">{$t("morphology.freeText")}</option>
                    <option value="__zero">∅</option>
                    {#each store.morphemes as morpheme (`${morpheme.table}/${morpheme.id}`)}
                      <option value={`ref:${morpheme.table}:${morpheme.id}`}
                        >{morpheme.surface}</option
                      >
                    {/each}
                  </select>
                  {#if isFree(cell)}
                    <input
                      class="cell-surface"
                      value={cell.surface}
                      oninput={(e) =>
                        onSurfaceInput(row, cell, e.currentTarget.value)}
                    />
                  {/if}
                  {#if cell.ambiguous}
                    <span class="ambiguous-mark" title={$t("morphology.ambiguous")}
                      >⚠</span
                    >
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if hidden}
      <p class="muted small">
        {$t("morphology.moreCombinations", { values: { count: hidden } })}
      </p>
    {/if}
  {/if}
</div>
