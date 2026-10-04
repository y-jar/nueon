import type { FieldValue } from "./api";

/** Human-readable text for any field value. */
export function displayValue(value?: FieldValue): string {
  if (!value) return "";
  switch (value.type) {
    case "text":
      return value.value;
    case "boolean":
      return value.value ? "true" : "false";
    case "tag_list":
      return value.value.join(", ");
    case "reference":
      return value.value;
    case "references":
      return value.value.join(", ");
    default:
      return "";
  }
}

/** The text of a `text` field value (empty otherwise). */
export function textValue(value?: FieldValue): string {
  return value && value.type === "text" ? value.value : "";
}

/** The flag of a `boolean` field value (false otherwise). */
export function boolValue(value?: FieldValue): boolean {
  return value && value.type === "boolean" ? value.value : false;
}

/** Comma-joined tags of a `tag_list` value. */
export function listValue(value?: FieldValue): string {
  return value && value.type === "tag_list" ? value.value.join(", ") : "";
}

/** Parse a comma-separated input into trimmed, non-empty tags. */
export function parseList(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
