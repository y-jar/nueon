<script lang="ts">
  import { t } from "svelte-i18n";
  import * as api from "../lib/api";
  import { ui, activeDoc, refreshTable, refreshTree } from "../lib/state.svelte";

  let { id }: { id: string } = $props();

  let nodes = $state<api.DerivationNode[]>([]);
  let candidates = $state<api.RelatedWord[]>([]);
  let chosen = $state("");
  let error = $state("");
  let exportPath = $state("");
  let exportStatus = $state("");

  const nodeMap = $derived(new Map(nodes.map((node) => [node.id, node])));
  const current = $derived(nodeMap.get(id) ?? null);

  /** Direct parents of the current word, nearest first. */
  const directParents = $derived(
    (current?.parents ?? [])
      .map((parent) => nodeMap.get(parent))
      .filter((node): node is api.DerivationNode => Boolean(node)),
  );

  /** Ancestor chain beyond the direct parents (walk first parents upward). */
  const ancestors = $derived.by(() => {
    const chain: api.DerivationNode[] = [];
    const seen = new Set<string>([id, ...directParents.map((p) => p.id)]);
    let cursor = directParents[0];
    while (cursor && cursor.parents.length) {
      const parent = nodeMap.get(cursor.parents[0]);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      chain.push(parent);
      cursor = parent;
    }
    return chain;
  });

  function childrenOf(nodeId: string): api.DerivationNode[] {
    return nodes.filter((node) => node.parents.includes(nodeId));
  }

  async function reload() {
    try {
      nodes = await api.derivationGraph(id);
    } catch (e) {
      error = String(e);
      return;
    }
    candidates = await api.parentCandidates(id).catch(() => []);
  }

  $effect(() => {
    const target = id;
    if (!target) return;
    error = "";
    exportStatus = "";
    reload();
    exportPath = `derivations/${ui.nameById[target] ?? "word"}`;
  });

  async function addParent() {
    const table = activeDoc().currentTable;
    if (!chosen || !table) return;
    const ok = await api.setParent(table, id, chosen);
    if (!ok) {
      error = $t("inspector.cannotAddParent");
      return;
    }
    error = "";
    chosen = "";
    await reload();
    await refreshTable();
  }

  async function reparentTo(parent: string) {
    const table = activeDoc().currentTable;
    if (!parent || !table) return;
    const ok = await api.reparentWord(table, id, parent);
    if (!ok) {
      error = $t("inspector.cannotAddParent");
      return;
    }
    error = "";
    chosen = "";
    await reload();
    await refreshTable();
  }

  async function dropParent(parent: string) {
    const table = activeDoc().currentTable;
    if (!table) return;
    await api.removeParent(table, id, parent);
    await reload();
    await refreshTable();
  }

  function buildMarkdown(): string {
    const lines: string[] = [
      `# ${$t("derivation.title")}: ${current?.wordname ?? id}`,
      "",
    ];
    if (ancestors.length) {
      lines.push(`## ${$t("derivation.ancestors")}`, "");
      for (const node of [...ancestors].reverse()) {
        lines.push(`- ${node.wordname}`);
      }
      lines.push("");
    }
    if (directParents.length) {
      lines.push(`## ${$t("inspector.parents")}`, "");
      for (const node of directParents) {
        lines.push(`- ${node.wordname}`);
      }
      lines.push("");
    }
    lines.push(`## ${$t("derivation.descendants")}`, "");
    const walk = (nodeId: string, depth: number) => {
      for (const child of childrenOf(nodeId)) {
        lines.push(`${"  ".repeat(depth)}- ${child.wordname}`);
        walk(child.id, depth + 1);
      }
    };
    const before = lines.length;
    walk(id, 0);
    if (lines.length === before) lines.push(`- ${$t("derivation.noDescendants")}`);
    return `${lines.join("\n")}\n`;
  }

  async function exportTree() {
    const path = exportPath.trim();
    if (!path) return;
    try {
      await api.createNoteWithContent(path, buildMarkdown());
      await refreshTree();
      exportStatus = $t("derivation.exportDone", { values: { path } });
    } catch (e) {
      error = String(e);
    }
  }
</script>

{#snippet branch(node: api.DerivationNode)}
  <li>
    <button class="node" onclick={() => (activeDoc().selectedEntry = node.id)}>
      {node.wordname}
    </button>
    {#if childrenOf(node.id).length}
      <ul>
        {#each childrenOf(node.id) as child (child.id)}
          {@render branch(child)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<div class="derivation">
  <div class="section-title">{$t("derivation.title")}</div>

  {#if current}
    {#if ancestors.length}
      <ul class="ancestor-chain">
        {#each [...ancestors].reverse() as node (node.id)}
          <li>
            <button class="node" onclick={() => (activeDoc().selectedEntry = node.id)}>
              {node.wordname}
            </button>
          </li>
        {/each}
      </ul>
      <div class="connector">↓</div>
    {/if}

    <div class="current-node">
      <button class="node current" onclick={() => (activeDoc().selectedEntry = id)}>
        {current.wordname}
      </button>
    </div>

    <ul class="parent-chips">
      {#each directParents as parent (parent.id)}
        <li>
          <button class="node" onclick={() => (activeDoc().selectedEntry = parent.id)}>
            {parent.wordname}
          </button>
          <button
            title={$t("derivation.makeSole")}
            onclick={() => reparentTo(parent.id)}>⇤</button
          >
          <button
            title={$t("derivation.remove")}
            onclick={() => dropParent(parent.id)}>✕</button
          >
        </li>
      {/each}
    </ul>

    <div class="row">
      <select bind:value={chosen}>
        <option value="">{$t("inspector.addParent")}</option>
        {#each candidates as candidate (candidate.id)}
          <option value={candidate.id}
            >{candidate.wordname} · {candidate.table}</option
          >
        {/each}
      </select>
      <button disabled={!chosen} onclick={addParent}>{$t("derivation.add")}</button>
      <button disabled={!chosen} onclick={() => reparentTo(chosen)}
        >{$t("derivation.reparent")}</button
      >
    </div>

    <div class="section-title">{$t("derivation.descendants")}</div>
    {#if childrenOf(id).length}
      <ul class="descendant-tree">
        {#each childrenOf(id) as child (child.id)}
          {@render branch(child)}
        {/each}
      </ul>
    {:else}
      <p class="muted">{$t("derivation.noDescendants")}</p>
    {/if}

    <div class="section-title">{$t("derivation.export")}</div>
    <div class="row">
      <input bind:value={exportPath} placeholder={$t("derivation.exportPath")} />
      <button onclick={exportTree}>{$t("derivation.export")}</button>
    </div>
    {#if exportStatus}<p class="muted">{exportStatus}</p>{/if}
  {:else}
    <p class="muted">{$t("inspector.selectWord")}</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</div>
