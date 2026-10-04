<script lang="ts">
  import type { NoteNode } from "../lib/api";
  import { ui, selectNote, renamePath, deletePath } from "../lib/state.svelte";
  import Tree from "./Tree.svelte";

  let { nodes, depth }: { nodes: NoteNode[]; depth: number } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  let editing = $state<string | null>(null);
  let editValue = $state("");
  let menuFor = $state<string | null>(null);

  function toggle(path: string) {
    collapsed[path] = !collapsed[path];
  }

  function parentOf(node: NoteNode): string {
    return node.path.split("/").slice(0, -1).join("/");
  }

  function startRename(node: NoteNode) {
    editing = node.path;
    editValue = node.name;
    menuFor = null;
  }

  async function commitRename(node: NoteNode) {
    const name = editValue.trim();
    editing = null;
    if (!name || name === node.name) return;
    const parent = parentOf(node);
    const target = parent ? `${parent}/${name}` : name;
    await renamePath(node.path, target);
  }

  async function doDelete(node: NoteNode) {
    menuFor = null;
    await deletePath(node.path);
  }
</script>

<ul class="tree-list">
  {#each nodes as node (node.path)}
    <li>
      <div class="tree-row" style="padding-left: {depth * 12}px">
        {#if node.is_dir}
          <button class="twisty" onclick={() => toggle(node.path)}
            >{collapsed[node.path] ? "▸" : "▾"}</button
          >
        {/if}

        {#if editing === node.path}
          <input
            class="new-input"
            bind:value={editValue}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename(node);
              if (e.key === "Escape") editing = null;
            }}
            onblur={() => commitRename(node)}
          />
        {:else}
          <button
            class="tree-name {ui.selected === node.path ? 'selected' : ''} {node.is_dir
              ? 'dir'
              : ''}"
            onclick={() =>
              node.is_dir ? toggle(node.path) : selectNote(node.path)}
            ondblclick={() => startRename(node)}
          >
            {node.name}
          </button>
          <button
            class="dots"
            onclick={() => (menuFor = menuFor === node.path ? null : node.path)}
            >⋯</button
          >
        {/if}
      </div>

      {#if menuFor === node.path}
        <div class="ctx" style="padding-left: {(depth + 1) * 12}px">
          <button onclick={() => startRename(node)}>Rename</button>
          <button onclick={() => doDelete(node)}>Delete</button>
        </div>
      {/if}

      {#if node.is_dir && !collapsed[node.path] && node.children.length}
        <Tree nodes={node.children} depth={depth + 1} />
      {/if}
    </li>
  {/each}
</ul>
