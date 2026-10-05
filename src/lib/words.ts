import * as api from "./api";

/** Result of creating a word together with its initial property values. */
export interface CreatedWord {
  id: string | null;
  /** Parents that were rejected (e.g. they would create a cycle). */
  rejectedParents: number;
}

/**
 * Create a word and persist its initial property values and parents.
 * Empty `values` and `parents` are skipped.
 */
export async function createWordWithValues(
  table: string,
  wordname: string,
  values: Record<string, api.FieldValue>,
  parents: string[],
): Promise<CreatedWord> {
  const id = await api.createWord(table, wordname);
  if (!id) return { id: null, rejectedParents: 0 };

  if (Object.keys(values).length > 0) {
    await api.saveWordEntry(table, { id, wordname, values });
  }

  let rejectedParents = 0;
  for (const parent of parents) {
    if (!(await api.setParent(table, id, parent))) rejectedParents += 1;
  }
  return { id, rejectedParents };
}
