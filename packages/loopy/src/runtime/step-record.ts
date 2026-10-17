import { isRecord, type Json, type StepRecord } from "../core/index.js";

function canonical(value: Json): Json {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  return Object.fromEntries(
    Object.entries(value)
      // Code-unit order: localeCompare treats composed and decomposed forms as equal.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function sameStepRecord(previous: StepRecord | undefined, next: StepRecord): boolean {
  return (
    previous !== undefined &&
    JSON.stringify(canonical(previous)) === JSON.stringify(canonical(next))
  );
}
