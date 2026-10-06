<script lang="ts">
  import { t } from "svelte-i18n";
  import { Info, List } from "@lucide/svelte";
  import * as api from "../../../lib/api";
  import { ui } from "../../../lib/state.svelte";

  interface Props {
    options: api.ImportOptions;
    detection: api.Detection | null;
  }

  let { options = $bindable(), detection }: Props = $props();

  type RoleKind =
    | "ignore"
    | "wordname"
    | "definition"
    | "parents"
    | "references"
    | "tag_flags"
    | "text_tag"
    | "list_tag"
    | "boolean_tag";

  const KINDS: RoleKind[] = [
    "wordname",
    "definition",
    "parents",
    "references",
    "tag_flags",
    "text_tag",
    "list_tag",
    "boolean_tag",
    "ignore",
  ];

  const NAMED = new Set<RoleKind>([
    "text_tag",
    "list_tag",
    "boolean_tag",
    "references",
  ]);

  function kindOf(role: api.ColumnRole): RoleKind {
    return role.role;
  }

  function nameOf(role: api.ColumnRole): string {
    return "name" in role ? role.name : "";
  }

  function withKind(role: api.ColumnRole, kind: RoleKind): api.ColumnRole {
    const name = nameOf(role);
    switch (kind) {
      case "text_tag":
        return { role: "text_tag", name };
      case "list_tag":
        return { role: "list_tag", name };
      case "boolean_tag":
        return { role: "boolean_tag", name };
      case "references":
        return { role: "references", name };
      default:
        return { role: kind };
    }
  }

  function setKind(index: number, kind: RoleKind) {
    const role = options.roles[index];
    if (role) options.roles[index] = withKind(role, kind);
  }

  /** Turn a #flag column into a single list column named after its header. */
  function toList(index: number, header: string) {
    const name = header.trim() || "tags";
    options.roles[index] = { role: "list_tag", name };
  }

  function setName(index: number, name: string) {
    const role = options.roles[index];
    if (!role) return;
    const kind = kindOf(role);
    if (kind === "text_tag") options.roles[index] = { role: "text_tag", name };
    else if (kind === "list_tag") options.roles[index] = { role: "list_tag", name };
    else if (kind === "boolean_tag")
      options.roles[index] = { role: "boolean_tag", name };
    else if (kind === "references")
      options.roles[index] = { role: "references", name };
  }

  const hasWordname = $derived(
    options.roles.some((r) => r.role === "wordname"),
  );
  const tableNames = $derived(ui.tables.map((t) => t.name));
</script>

<div class="import-step">
  <div class="import-grid">
    <label class="import-field">
      <span>{$t("import.targetTable")}</span>
      <input list="import-table-names" bind:value={options.target_table} />
      <datalist id="import-table-names">
        {#each tableNames as name (name)}
          <option value={name}></option>
        {/each}
      </datalist>
    </label>

    <label class="import-field">
      <span>{$t("import.duplicatePolicy")}</span>
      <select bind:value={options.duplicate_policy}>
        <option value="skip">{$t("import.policySkip")}</option>
        <option value="update">{$t("import.policyUpdate")}</option>
        <option value="add">{$t("import.policyAdd")}</option>
      </select>
    </label>

    <label class="import-field">
      <span>{$t("import.linkSyntax")}</span>
      <select bind:value={options.link_syntax}>
        <option value="wiki">{$t("import.linkWiki")}</option>
        <option value="none">{$t("import.linkNone")}</option>
      </select>
    </label>
  </div>

  <div class="import-checks">
    <label>
      <input type="checkbox" bind:checked={options.create_suffix_entries} />
      {$t("import.createSuffix")}
    </label>
  </div>

  {#if detection}
    <table class="import-table">
      <thead>
        <tr>
          <th>{$t("import.colHeader")}</th>
          <th>{$t("import.colSamples")}</th>
          <th>{$t("import.colRole")}</th>
          <th>{$t("import.colTagName")}</th>
        </tr>
      </thead>
      <tbody>
        {#each detection.columns as column (column.index)}
          <tr>
            <td class="import-col-header">{column.header || `column ${column.index + 1}`}</td>
            <td class="muted">
              {column.distinct_values}
              {#if column.reasons.length}
                <span class="import-reason" title={column.reasons.join(" · ")}>
                  <Info size={12} />
                </span>
              {/if}
            </td>
            <td>
              <div class="import-role-cell">
                <select
                  value={kindOf(options.roles[column.index] ?? column.role)}
                  onchange={(e) => setKind(column.index, e.currentTarget.value as RoleKind)}
                >
                  {#each KINDS as kind (kind)}
                    <option value={kind}>{$t(`import.role_${kind}`)}</option>
                  {/each}
                </select>
                {#if kindOf(options.roles[column.index] ?? column.role) === "tag_flags"}
                  <button
                    class="import-quick"
                    title={$t("import.storeAsList")}
                    aria-label={$t("import.storeAsList")}
                    onclick={() => toList(column.index, column.header)}
                  >
                    <List size={13} />
                  </button>
                {/if}
              </div>
            </td>
            <td>
              {#if NAMED.has(kindOf(options.roles[column.index] ?? column.role))}
                <input
                  value={nameOf(options.roles[column.index] ?? column.role)}
                  oninput={(e) => setName(column.index, e.currentTarget.value)}
                />
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if !hasWordname}
    <p class="error">{$t("import.needWordname")}</p>
  {/if}
  {#if !options.target_table.trim()}
    <p class="error">{$t("import.needTarget")}</p>
  {/if}
</div>
