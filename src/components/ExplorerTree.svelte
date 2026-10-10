<script lang="ts">
  import { autofocus } from "../lib/actions";
  import {
    ChevronDown,
    ChevronRight,
    File,
    FileArchive,
    FileImage,
    FileText,
    FileVideo,
    Folder,
    FolderOpen,
    MoreHorizontal,
    Music,
  } from "@lucide/svelte";
  import type { NoteNode } from "../lib/api";
  import { fileCategory, stripMd } from "../lib/explorer";
  import {
    ui,
    activeDoc,
    selectNote,
    renamePath,
    movePath,
    canMoveInto,
    openContextMenu,
    consumeRename,
    tr,
  } from "../lib/state.svelte";
  import ExplorerTree from "./ExplorerTree.svelte";

  let { nodes, depth }: { nodes: NoteNode[]; depth: number } = $props();

  /** Label shown for a node: files hide their `.md` extension. */
  function labelOf(node: NoteNode): string {
    return node.is_dir ? node.name : stripMd(node.name);
  }

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
        editValue = labelOf(node);
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
    if (!name || name === labelOf(node)) return;
    const parent = parentOf(node);
    const target = parent ? `${parent}/${name}` : name;
    try {
      await renamePath(node.path, target);
    } catch (error) {
      ui.status = tr("status.couldNotRenameFile", {
        name: labelOf(node),
        error: String(error),
      });
    }
  }

  function onDragStart(event: DragEvent, node: NoteNode) {
    ui.dragPath = node.path;
    event.dataTransfer?.setData("text/plain", node.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  /** Dropping on a folder moves into it; on a file, into that file's folder. */
  function dropFolderFor(node: NoteNode): string {
    return node.is_dir ? node.path : parentOf(node);
  }

  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  let expandTarget: string | null = null;

  function clearExpand() {
    if (expandTimer) clearTimeout(expandTimer);
    expandTimer = null;
    expandTarget = null;
  }

  function onDragOver(event: DragEvent, node: NoteNode) {
    const src = ui.dragPath;
    if (!src || !canMoveInto(src, dropFolderFor(node))) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOver = node.path;

    // Hovering a collapsed folder opens it so nested targets are reachable.
    if (node.is_dir && collapsed[node.path] && expandTarget !== node.path) {
      clearExpand();
      expandTarget = node.path;
      expandTimer = setTimeout(() => {
        collapsed[node.path] = false;
        clearExpand();
      }, 600);
    }
  }

  async function onDrop(event: DragEvent, node: NoteNode) {
    const src = ui.dragPath;
    if (!src || !canMoveInto(src, dropFolderFor(node))) return;
    event.preventDefault();
    event.stopPropagation();
    dragOver = null;
    ui.dragPath = null;
    clearExpand();
    await movePath(src, dropFolderFor(node));
  }
</script>

<ul class="tree-list">
  {#each nodes as node (node.path)}
    <li>
      <div
        class="tree-row"
        role="treeitem"
        tabindex="-1"
        data-path={node.path}
        data-dir={node.is_dir}
        aria-selected={activeDoc().selected === node.path}
        class:drop-target={dragOver === node.path && node.is_dir}
        class:drop-sibling={dragOver === node.path && !node.is_dir}
        draggable={editing !== node.path}
        ondragstart={(e) => onDragStart(e, node)}
        ondragend={() => {
          ui.dragPath = null;
          dragOver = null;
          clearExpand();
        }}
        ondragover={(e) => onDragOver(e, node)}
        ondragleave={() => {
          dragOver = null;
          clearExpand();
        }}
        ondrop={(e) => onDrop(e, node)}
        oncontextmenu={(e) => {
          e.preventDefault();
          // Keep the root handler (empty space) from replacing this menu.
          e.stopPropagation();
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
        {:else if fileCategory(node.name) === "image"}
          <FileImage size={14} class="tree-icon" />
        {:else if fileCategory(node.name) === "audio"}
          <Music size={14} class="tree-icon" />
        {:else if fileCategory(node.name) === "video"}
          <FileVideo size={14} class="tree-icon" />
        {:else if fileCategory(node.name) === "archive"}
          <FileArchive size={14} class="tree-icon" />
        {:else if fileCategory(node.name) === "other"}
          <File size={14} class="tree-icon" />
        {:else}
          <FileText size={14} class="tree-icon" />
        {/if}

        {#if editing === node.path}
          <input
            use:autofocus={{ select: true }}
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
            onclick={(e) => {
              if (node.is_dir) {
                toggle(node.path);
                return;
              }
              void selectNote(node.path, { force: e.ctrlKey || e.metaKey });
            }}
            onauxclick={(e) => {
              if (e.button === 1 && !node.is_dir) {
                e.preventDefault();
                void selectNote(node.path, { force: true });
              }
            }}
            ondblclick={() => {
              editing = node.path;
              editValue = labelOf(node);
            }}
          >
            {labelOf(node)}
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
