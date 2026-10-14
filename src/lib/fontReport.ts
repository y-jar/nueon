//! Pure helpers for the font export validation report.
import type { FontIssue } from "./api";

export type Severity = FontIssue["severity"];

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function summarise(issues: FontIssue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

/** Only errors stop an export; warnings and notes are advice. */
export function canExport(issues: FontIssue[]): boolean {
  return !issues.some((issue) => issue.severity === "error");
}

export interface IssueGroup {
  glyph: string;
  name: string;
  worst: Severity;
  issues: FontIssue[];
}

/** Issues grouped per glyph; glyphs with the worst problems come first. */
export function groupIssues(issues: FontIssue[]): IssueGroup[] {
  const byGlyph = new Map<string, IssueGroup>();
  for (const issue of issues) {
    let group = byGlyph.get(issue.glyph);
    if (!group) {
      group = { glyph: issue.glyph, name: issue.name, worst: issue.severity, issues: [] };
      byGlyph.set(issue.glyph, group);
    }
    group.issues.push(issue);
    if (RANK[issue.severity] < RANK[group.worst]) group.worst = issue.severity;
  }
  const groups = [...byGlyph.values()];
  for (const group of groups) group.issues.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return groups.sort((a, b) => RANK[a.worst] - RANK[b.worst] || a.name.localeCompare(b.name));
}
