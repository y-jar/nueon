<!-- Source Control: status, diff, history and check-in. -->
<script lang="ts">
  import { t } from "svelte-i18n";
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
  let showId = $state<string | null>(null);
  let showOutput = $state("");
  let message = $state("");
  let error = $state("");
  let branches = $state<string[]>([]);
  let newBranch = $state("");
  let dismissed = $state(false);

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
      branches = [];
      return;
    }
    try {
      info = await api.vcsState();
      dismissed = await api.gitPromptDismissed();
      if (info.state === "ready") {
        status = await api.vcsStatus();
        log = await api.vcsLog(20);
        auto = await api.autocheckinGet();
        branches = await api.vcsBranches();
      } else {
        status = [];
        log = [];
        branches = [];
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
    showId = null;
    try {
      diff = await api.vcsDiff(path);
    } catch (e) {
      error = String(e);
    }
  }

  async function viewCommit(id: string) {
    diffPath = null;
    showId = id;
    try {
      showOutput = await api.vcsShow(id);
    } catch (e) {
      error = String(e);
    }
  }

  async function dismissPrompt() {
    try {
      await api.setGitPromptDismissed(true);
      dismissed = true;
    } catch (e) {
      error = String(e);
    }
  }

  async function switchBranch(name: string) {
    if (!name) return;
    try {
      await api.vcsCheckout(name);
      await reload();
    } catch (e) {
      error = String(e);
    }
  }

  async function createBranch() {
    const name = newBranch.trim();
    if (!name) return;
    try {
      await api.vcsCreateBranch(name);
      newBranch = "";
      await reload();
    } catch (e) {
      error = String(e);
    }
  }

  async function commit() {
    try {
      await api.vcsCommit(message.trim() || "nueon: check-in");
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

<aside class="sidebar git-panel">
  <div class="pane-title">{$t("git.sourceControl")}</div>

  {#if !ui.root}
    <p class="muted">{$t("git.noWorkspace")}</p>
  {:else if info?.state === "git_missing"}
    <p class="error">{$t("git.gitMissing")}</p>
    <p class="muted">{$t("git.installHint")}</p>
    {#if !dismissed}
      <button onclick={dismissPrompt}>{$t("git.dontShowAgain")}</button>
    {/if}
  {:else if info?.state === "not_a_repo"}
    <p class="muted">{$t("git.notARepo")}</p>
    <button onclick={initRepo}>{$t("git.initialize")}</button>
    {#if !dismissed}
      <button onclick={dismissPrompt}>{$t("git.dontShowAgain")}</button>
    {/if}
  {:else if info?.state === "ready"}
    <div class="row">
      <select
        value={info.branch ?? ""}
        onchange={(e) => switchBranch(e.currentTarget.value)}
      >
        {#each branches as branch (branch)}
          <option value={branch}>{branch}</option>
        {/each}
      </select>
    </div>
    <div class="row">
      <input
        placeholder={$t("git.newBranch")}
        bind:value={newBranch}
        onkeydown={(e) => e.key === "Enter" && createBranch()}
      />
      <button onclick={createBranch}>{$t("git.createBranch")}</button>
    </div>

    <label class="field inline">
      <input
        type="checkbox"
        checked={auto.enabled}
        onchange={(e) => toggleAuto(e.currentTarget.checked)}
      />
      {$t("git.autoCheckin", { values: { secs: auto.secs } })}
    </label>

    <div class="section-title">
      {$t("git.changes", { values: { count: status.length } })}
    </div>
    {#if status.length === 0}
      <p class="muted">{$t("git.clean")}</p>
    {/if}
    <ul class="vcs-status">
      {#each status as entry (entry.path)}
        <li>
          <button class="link" onclick={() => loadDiff(entry.path)}
            >{entry.code} {entry.path}</button
          >
          <button title={$t("git.revertFile")} onclick={() => revert(entry.path)}
            >↺</button
          >
        </li>
      {/each}
    </ul>

    <textarea
      rows="2"
      placeholder={$t("git.commitMessage")}
      bind:value={message}
    ></textarea>
    <button onclick={commit}>{$t("git.checkIn")}</button>

    {#if diffPath}
      <div class="section-title">
        {$t("git.diff", { values: { path: diffPath } })}
      </div>
      {#if diff.trim() === ""}
        <p class="muted">{$t("git.noDiff")}</p>
      {:else}
        {@const view = truncate(diff)}
        <pre class="diff">{view.text}{view.clipped
            ? "\n" + $t("git.truncated")
            : ""}</pre>
      {/if}
    {/if}

    <div class="section-title">{$t("git.history")}</div>
    <ul class="vcs-log">
      {#each log as entry (entry.id)}
        <li>
          <button class="log-row" onclick={() => viewCommit(entry.id)}>
            <span class="hash mono">{entry.id.slice(0, 7)}</span>
            <span class="summary">{entry.summary}</span>
          </button>
        </li>
      {/each}
    </ul>

    {#if showId}
      <div class="section-title">
        {$t("git.show", { values: { id: showId.slice(0, 7) } })}
      </div>
      {@const commitView = truncate(showOutput)}
      <pre class="diff">{commitView.text}{commitView.clipped
          ? "\n" + $t("git.truncated")
          : ""}</pre>
    {/if}
  {:else}
    <p class="muted">{$t("git.loading")}</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</aside>
