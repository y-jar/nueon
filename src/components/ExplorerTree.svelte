<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    FileText,
    Folder,
    FolderOpen,
    MoreHorizontal,
  } from "@lucide/svelte";
  import type { NoteNode } from "../lib/api";
  import {
    ui,
    activeDoc,
    selectNote,
    renamePath,
    openContextMenu,
    consumeRename,
  } from "../lib/state.svelte";
  import ExplorerTree from "./ExplorerTree.svelte";

  let { nodes, depth }: { nodes: NoteNode[]; depth: number } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  let editing = $state<string | null>(null);
  let editValue = $state("");
  let dragOver = $state<string | null>(null);

  // "Collapse all" requests from the context menu.
  $effect(() => {
    void ui.collapseAllSignal;
    collapsed = {};
  });

  // Context-menu rename requests from the overlay.
  $effect(() => {
    const target = ui.renameTarget;
    if (target) {
      const node: NoteNode | undefined = nodes.find((n) => n.path === target);
      if (node) {
        editing = node.path;
        editValue = node.name;
        consumeRename();
      }
    }
  });

  function toggle(path: string) {
    collapsed[path] = !collapsed[path];
  }

  function parentOf(node: NoteNode): string {
    return node.path.split("/").slice(0, -1).join("/");
  }

  async function commitRename(node: NoteNode) {
    const name = editValue.trim();
    editing = null;
    if (!name || name === node.name) return;
    const parent = parentOf(node);
    const target = parent ? `${parent}/${name}` : name;
    await renamePath(node.path, target);
  }

  function onDragStart(event: DragEvent, node: NoteNode) {
    ui.dragPath = node.path;
    event.dataTransfer?.setData("text/plain", node.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function validDrop(folderPath: string | null): boolean {
    const src = ui.dragPath;
    if (!src) return false;
    if (folderPath === null) return true;
    return folderPath !== src && !folderPath.startsWith(`${src}/`);
  }

  function onDragOver(event: DragEvent, node: NoteNode) {
    if (!node.is_dir || !validDrop(node.path)) return;
    event.preventDefault();
    event.stopPropagation();
    dragOver = node.path;
  }

  async function onDrop(event: DragEvent, node: NoteNode) {
    if (!node.is_dir) return;
    event.preventDefault();
    event.stopPropagation();
    const src = ui.dragPath;
    dragOver = null;
    ui.dragPath = null;
    if (!src || !validDrop(node.path)) return;
    const name = src.split("/").pop() ?? src;
    const target = `${node.path}/${name}`;
    if (target === src) return;
    await renamePath(src, target);
  }
</script>

<ul class="tree-list">
  {#each nodes as node (node.path)}
    <li>
      <div
        class="tree-row"
        role="treeitem"
        tabindex="-1"
        aria-selected={activeDoc().selected === node.path}
        class:drop-target={dragOver === node.path && node.is_dir}
        draggable={editing !== node.path}
        ondragstart={(e) => onDragStart(e, node)}
        ondragend={() => (ui.dragPath = null)}
        ondragover={(e) => onDragOver(e, node)}
        ondragleave={() => (dragOver = null)}
        ondrop={(e) => onDrop(e, node)}
        oncontextmenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, node.path, node.is_dir, "node");
        }}
        style="padding-left: {depth * 12 + 4}px"
      >
        {#if node.is_dir}
          <button class="twisty" onclick={() => toggle(node.path)}>
            {#if collapsed[node.path]}
              <ChevronRight size={13} />
            {:else}
              <ChevronDown size={13} />
            {/if}
          </button>
          {#if collapsed[node.path]}
            <Folder size={14} class="tree-icon" />
          {:else}
            <FolderOpen size={14} class="tree-icon" />
          {/if}
        {:else}
          <FileText size={14} class="tree-icon" />
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
            class="tree-name {activeDoc().selected === node.path ? 'selected' : ''} {node.is_dir
              ? 'dir'
              : ''}"
            onclick={() =>
              node.is_dir ? toggle(node.path) : selectNote(node.path)}
            ondblclick={() => {
              editing = node.path;
              editValue = node.name;
            }}
          >
            {node.name}
          </button>
          <button
            class="dots"
            title="More"
            onclick={(e) =>
              openContextMenu(
                e.clientX,
                e.clientY,
                node.path,
                node.is_dir,
                "node",
              )}
          >
            <MoreHorizontal size={14} />
          </button>
        {/if}
      </div>

      {#if node.is_dir && !collapsed[node.path] && node.children.length}
        <ExplorerTree nodes={node.children} depth={depth + 1} />
      {/if}
    </li>
  {/each}
</ul>
