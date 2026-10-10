<!-- Ctrl+P palette of recent notes, tables and actions. -->
<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "svelte-i18n";
  import { onMount } from "svelte";
  import { autofocus } from "../lib/actions";
  import { stripMd } from "../lib/explorer";
  import * as api from "../lib/api";
  import type { NoteNode } from "../lib/api";
  import {
    activeDoc,
    openImport,
    openSettings,
    openTable,
    requestNew,
    selectNote,
    selectTable,
    setActivity,
    ui,
    type Activity,
  } from "../lib/state.svelte";

  interface Command {
    id: string;
    label: string;
    hint: string;
    run: () => void;
  }

  let query = $state("");
  let selected = $state(0);
  let recents = $state<string[]>([]);

  onMount(() => {
    void api.recentList().then((list) => (recents = list));
  });

  const tr = $derived(get(t));

  function close() {
    ui.paletteOpen = false;
  }

  function flatten(nodes: NoteNode[], into: NoteNode[] = []): NoteNode[] {
    for (const node of nodes) {
      if (node.is_dir) flatten(node.children, into);
      else into.push(node);
    }
    return into;
  }

  const commands = $derived.by(() => {
    const list: Command[] = [];
    for (const entry of recents) {
      if (entry.startsWith("note:")) {
        const path = entry.slice(5);
        list.push({
          id: `recent-note-${path}`,
          label: stripMd(path.split("/").pop() ?? path),
          hint: tr("palette.recent"),
          run: () => {
            void selectNote(path);
            close();
          },
        });
      } else if (entry.startsWith("table:")) {
        const name = entry.slice(6);
        list.push({
          id: `recent-table-${name}`,
          label: name,
          hint: tr("palette.recent"),
          run: () => {
            void selectTable(name);
            close();
          },
        });
      }
    }
    const activities: [Activity, string][] = [
      ["notes", tr("activity.notes")],
      ["dictionary", tr("activity.dictionary")],
      ["translation", tr("activity.translation")],
      ["morphology", tr("activity.morphology")],
      ["phonology", tr("activity.phonology")],
      ["git", tr("activity.git")],
    ];
    for (const [id, label] of activities) {
      list.push({
        id: `activity-${id}`,
        label,
        hint: tr("palette.activity"),
        run: () => {
          setActivity(id);
          close();
        },
      });
    }
    list.push({
      id: "new-note",
      label: tr("contextMenu.newNote"),
      hint: tr("palette.new"),
      run: () => {
        requestNew("note", "");
        setActivity("notes");
        close();
      },
    });
    list.push({
      id: "settings",
      label: tr("settings.title"),
      hint: tr("palette.open"),
      run: () => {
        openSettings();
        close();
      },
    });
    list.push({
      id: "import",
      label: tr("import.title"),
      hint: tr("palette.open"),
      run: () => {
        openImport();
        close();
      },
    });
    for (const node of flatten(ui.tree)) {
      list.push({
        id: `note-${node.path}`,
        label: stripMd(node.name),
        hint: tr("palette.note"),
        run: () => {
          void selectNote(node.path);
          close();
        },
      });
    }
    for (const table of ui.tables) {
      list.push({
        id: `table-${table.name}`,
        label: table.name,
        hint: tr("palette.table"),
        run: () => {
          void selectTable(table.name);
          close();
        },
      });
    }
    for (const hits of Object.values(ui.wordIndex)) {
      for (const hit of hits) {
        list.push({
          id: `word-${hit.id}`,
          label: hit.wordname,
          hint: `${tr("palette.word")} · ${hit.table}`,
          run: () => {
            void openTable(hit.table).then(() => {
              activeDoc().selectedEntry = hit.id;
            });
            close();
          },
        });
      }
    }
    return list;
  });

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? commands.filter((command) => command.label.toLowerCase().includes(needle))
      : commands.slice(0, 50);
    return list;
  });

  $effect(() => {
    selected = 0;
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (event.key === "Enter") {
      const command = filtered[selected];
      if (command) command.run();
    }
  }
</script>

<div
  class="palette-overlay"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && close()}
>
  <div class="palette" role="dialog" aria-label={tr("palette.title")}>
    <input
      use:autofocus={{ select: true }}
      placeholder={tr("palette.placeholder")}
      bind:value={query}
      onkeydown={onKeydown}
    />
    <div class="palette-list">
      {#if filtered.length === 0}
        <p class="muted">{tr("palette.noResults")}</p>
      {:else}
        {#each filtered as command, index (command.id)}
          <button
            class="palette-row"
            class:active={index === selected}
            onpointermove={() => (selected = index)}
            onclick={() => command.run()}
          >
            <span class="grow">{command.label}</span>
            <span class="muted">{command.hint}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>
