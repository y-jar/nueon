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
  <div class="pane-title">{$t("git.sourceControl")}</div>

  {#if !ui.root}
    <p class="muted">{$t("git.noWorkspace")}</p>
  {:else if info?.state === "git_missing"}
    <p class="error">{$t("git.gitMissing")}</p>
    <p class="muted">{$t("git.installHint")}</p>
  {:else if info?.state === "not_a_repo"}
    <p class="muted">{$t("git.notARepo")}</p>
    <button onclick={initRepo}>{$t("git.initialize")}</button>
  {:else if info?.state === "ready"}
    <p class="muted">
      {$t("git.branch", { values: { branch: info.branch ?? "HEAD" } })}
    </p>

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
          <span class="mono">{entry.id.slice(0, 7)}</span>
          {entry.summary}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">{$t("git.loading")}</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</aside>
