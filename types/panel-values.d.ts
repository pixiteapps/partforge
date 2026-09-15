// partforge/panel-values — the value contract of a `type: "custom"` control.

export const CUSTOM_VALUE_MAX_BYTES: 16384;
export const CUSTOM_VALUE_MAX_DEPTH: 8;

export interface JsonValueLimits { maxBytes?: number; maxDepth?: number }

/** A string, boolean, finite number, or an array / plain object of those. */
export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** Why `v` is not a JSON value within the caps (a fragment such as `is null at tiles[2].h`), or null. */
export function jsonValueProblem(v: unknown, limits?: JsonValueLimits): string | null;
export function isJsonValue(v: unknown, limits?: JsonValueLimits): v is JsonValue;

/** Parse an array/object literal's source text (bare or quoted keys, trailing commas, JS string escapes). Null on anything else. */
export function readJsonLiteral(text: string): { value: JsonValue } | null;
/** Source text for a value: compact under 80 chars, else indented JSON relative to `indent`. */
export function writeJsonLiteral(value: JsonValue, opts?: { indent?: string }): string;
