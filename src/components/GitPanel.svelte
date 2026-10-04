<script lang="ts">
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";

  const MAX_DIFF_LINES = 300;
  const MAX_DIFF_CHARS = 20000;

  let info = $state<api.VcsInfo | null>(null);
  let status = $state<api.StatusEntry[]>([]);
  let log = $state<api.Commit[]>([]);
  let auto = $state<api.AutoCheckinInfo>({ enabled: false, secs: 60 });
  let diff = $state("");
  let diffPath = $state<string | null>(null);
  let message = $state("");
  let error = $state("");

  $effect(() => {
    // Re-run on workspace switch and on any vcs event.
    void ui.vcsRevision;
    void ui.root;
    reload();
  });

  async function reload() {
    if (!ui.root) {
      info = null;
      status = [];
      log = [];
      diff = "";
      return;
    }
    try {
      info = await api.vcsState();
      if (info.state === "ready") {
        status = await api.vcsStatus();
        log = await api.vcsLog(20);
        auto = await api.autocheckinGet();
      } else {
        status = [];
        log = [];
      }
      if (diffPath) {
        diff = await api.vcsDiff(diffPath);
      }
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function loadDiff(path: string) {
    diffPath = path;
    try {
      diff = await api.vcsDiff(path);
    } catch (e) {
      error = String(e);
    }
  }

  async function commit() {
    try {
      await api.vcsCommit(message.trim() || "langloom: check-in");
      message = "";
      await reload();
    } catch (e) {
      error = String(e);
    }
  }

  async function initRepo() {
    try {
      await api.vcsInit();
      await reload();
    } catch (e) {
      error = String(e);
    }
  }

  async function revert(path: string) {
    try {
      await api.vcsRevertFile(path);
      diffPath = null;
      diff = "";
      await reload();
    } catch (e) {
      error = String(e);
    }
  }

  async function toggleAuto(enabled: boolean) {
    try {
      await api.autocheckinSet(enabled, auto.secs);
      auto = { ...auto, enabled };
    } catch (e) {
      error = String(e);
    }
  }

  function truncate(text: string): { text: string; clipped: boolean } {
    const lines = text.split("\n");
    let clipped = lines.length > MAX_DIFF_LINES;
    let out = lines.slice(0, MAX_DIFF_LINES).join("\n");
    if (out.length > MAX_DIFF_CHARS) {
      out = out.slice(0, MAX_DIFF_CHARS);
      clipped = true;
    }
    return { text: out, clipped };
  }
</script>

<aside class="inspector git-panel">
  <div class="pane-title">Source Control</div>

  {#if !ui.root}
    <p class="muted">No workspace open.</p>
  {:else if info?.state === "git_missing"}
    <p class="error">git is not installed.</p>
    <p class="muted">Install git to enable version control.</p>
  {:else if info?.state === "not_a_repo"}
    <p class="muted">This workspace is not a git repository.</p>
    <button onclick={initRepo}>Initialize repository</button>
  {:else if info?.state === "ready"}
    <p class="muted">branch: {info.branch ?? "HEAD"}</p>

    <label class="field inline">
      <input
        type="checkbox"
        checked={auto.enabled}
        onchange={(e) => toggleAuto(e.currentTarget.checked)}
      />
      auto check-in ({auto.secs}s idle)
    </label>

    <div class="section-title">Changes ({status.length})</div>
    {#if status.length === 0}
      <p class="muted">clean</p>
    {/if}
    <ul class="vcs-status">
      {#each status as entry (entry.path)}
        <li>
          <button class="link" onclick={() => loadDiff(entry.path)}
            >{entry.code} {entry.path}</button
          >
          <button title="Revert file" onclick={() => revert(entry.path)}
            >↺</button
          >
        </li>
      {/each}
    </ul>

    <textarea rows="2" placeholder="commit message" bind:value={message}
    ></textarea>
    <button onclick={commit}>Check in</button>

    {#if diffPath}
      <div class="section-title">Diff: {diffPath}</div>
      {#if diff.trim() === ""}
        <p class="muted">(no diff — untracked or binary)</p>
      {:else}
        {@const view = truncate(diff)}
        <pre class="diff">{view.text}{view.clipped ? "\n… truncated" : ""}</pre>
      {/if}
    {/if}

    <div class="section-title">History</div>
    <ul class="vcs-log">
      {#each log as entry (entry.id)}
        <li>
          <span class="mono">{entry.id.slice(0, 7)}</span>
          {entry.summary}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">Loading…</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</aside>
