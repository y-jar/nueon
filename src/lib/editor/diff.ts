/**
 * Minimal text splice shared by the editor's buffer reload: trim the common
 * prefix and suffix so only the changed middle is dispatched. CodeMirror maps
 * the cursor and scroll position through the change itself — an external edit
 * below the cursor leaves it still, one above shifts it, and one overlapping
 * it lands on the nearest valid boundary.
 */
export interface Splice {
  /** Offset in the current text where the change starts. */
  from: number;
  /** Offset in the current text where the change ends. */
  to: number;
  /** Replacement text for `current[from..to]`. */
  insert: string;
}

/**
 * The smallest replacement that turns `current` into `next`, or `null` when
 * they are identical.
 *
 * Surrogate pairs can never be split: a high surrogate only equals another
 * high surrogate, so a prefix ending mid-pair means both strings share the
 * high half and the insert begins with the other's low half — still a valid
 * pair. The same holds symmetrically for the suffix.
 */
export function diffSplice(current: string, next: string): Splice | null {
  if (current === next) return null;
  let from = 0;
  const shared = Math.min(current.length, next.length);
  while (from < shared && current.charCodeAt(from) === next.charCodeAt(from)) {
    from += 1;
  }
  let to = current.length;
  let insertEnd = next.length;
  while (
    to > from &&
    insertEnd > from &&
    current.charCodeAt(to - 1) === next.charCodeAt(insertEnd - 1)
  ) {
    to -= 1;
    insertEnd -= 1;
  }
  return { from, to, insert: next.slice(from, insertEnd) };
}
