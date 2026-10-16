import type { Json } from "loopy";

export type Files = Record<string, string>;

export type JsonObject = { [key: string]: Json };

type Path = (string | number)[];

type Replacement = { start: number; end: number; text: string };

// BOUNDARY: Asset JSON objects are validated before selecting fields.
export function object(value: Json | undefined, location: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected JSON object at ${location}.`);
  }

  return value;
}

// BOUNDARY: Selected asset fields must be strings before text transforms run.
export function string(value: Json | undefined, location: string) {
  if (typeof value !== "string") {
    throw new Error(`Expected string at ${location}.`);
  }

  return value;
}

export function read(files: Files, path: string) {
  const value = files[path];

  if (value === undefined) {
    throw new Error(`Missing file ${path}.`);
  }

  return value;
}

export function parse(text: string): Json {
  // SAFETY: JSON.parse produces JSON values; consumers validate the shape they require.
  return JSON.parse(text) as Json;
}

export function readJson(files: Files, path: string) {
  return object(parse(read(files, path)), path);
}

// Spans let updates retain export formatting and untouched bytes.
class JsonSpans {
  spans = new Map<string, [number, number]>();
  constructor(private text: string) {
    this.value(0, []);
  }
  space(start: number) {
    let cursor = start;

    while (/\s/.test(this.text[cursor] ?? "")) {
      cursor++;
    }

    return cursor;
  }
  stringEnd(start: number) {
    let cursor = start + 1;

    while (cursor < this.text.length) {
      if (this.text[cursor] === "\\") {
        cursor += 2;
      } else if (this.text[cursor++] === '"') {
        return cursor;
      }
    }

    throw new Error("Malformed JSON string.");
  }
  container(start: number, path: Path, array: boolean) {
    let cursor = this.space(start + 1);
    let index = 0;
    const end = array ? "]" : "}";

    while (this.text[cursor] !== end) {
      let key: string | number = index++;

      if (!array) {
        const keyEnd = this.stringEnd(cursor);
        key = string(parse(this.text.slice(cursor, keyEnd)), "object key");
        cursor = this.space(keyEnd) + 1;
      }

      cursor = this.space(this.value(cursor, [...path, key]));

      if (this.text[cursor] === ",") {
        cursor = this.space(cursor + 1);
      }
    }

    return cursor + 1;
  }
  value(start: number, path: Path): number {
    const cursor = this.space(start);
    const first = this.text[cursor];
    let end = cursor;

    if (first === "{" || first === "[") {
      end = this.container(cursor, path, first === "[");
    } else if (first === '"') {
      end = this.stringEnd(cursor);
    } else {
      while (end < this.text.length && !/[\s,}\]]/.test(this.text.charAt(end))) {
        end++;
      }
    }

    this.spans.set(JSON.stringify(path), [cursor, end]);

    return end;
  }
}

function compare(before: Json, after: Json, path: Path, spans: JsonSpans, changes: Replacement[]) {
  if (Object.is(before, after)) {
    return;
  }

  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (const [index, item] of before.entries()) {
      compare(item, after[index] ?? null, [...path, index], spans, changes);
    }

    return;
  }

  if (isObject(before) && isObject(after)) {
    if (
      Object.keys(before).length !== Object.keys(after).length ||
      Object.keys(before).some((key) => !(key in after))
    ) {
      throw new Error("Refusing to reformat existing JSON structure.");
    }

    for (const key of Object.keys(before)) {
      compare(before[key] ?? null, after[key] ?? null, [...path, key], spans, changes);
    }

    return;
  }

  const span = spans.spans.get(JSON.stringify(path));

  if (!span || Array.isArray(after) || isObject(after)) {
    throw new Error(`Cannot target JSON value at ${path.join(".")}.`);
  }

  changes.push({ start: span[0], end: span[1], text: JSON.stringify(after) });
}

export function writeJson(files: Files, path: string, next: JsonObject) {
  const original = read(files, path);
  const changes: Replacement[] = [];
  compare(parse(original), next, [], new JsonSpans(original), changes);
  let patched = original;

  for (const change of changes.sort((a, b) => b.start - a.start)) {
    patched = `${patched.slice(0, change.start)}${change.text}${patched.slice(change.end)}`;
  }

  files[path] = patched;
}

export function appendRegistration(
  files: Files,
  path: string,
  assetClass: string,
  entry: JsonObject,
) {
  const original = read(files, path);
  const details = object(readJson(files, path).assetClassVsAssetDetails, path);
  const entries = details[assetClass];

  if (!Array.isArray(entries)) {
    throw new Error(`Manifest has no ${assetClass} entries: ${path}.`);
  }

  const matches = entries.filter((item) => object(item, path).assetId === entry.assetId);

  if (matches.length > 1) {
    throw new Error(`Manifest has duplicate registration ${entry.assetId}: ${path}.`);
  }

  if (matches.length) {
    return;
  }

  const span = new JsonSpans(original).spans.get(
    JSON.stringify(["assetClassVsAssetDetails", assetClass]),
  );

  if (!span) {
    throw new Error(`Missing registration array in ${path}.`);
  }

  files[path] = insertEntry(original, span, entry);
}

function insertEntry(original: string, [start, end]: [number, number], entry: JsonObject) {
  let trailing = end - 1;

  while (trailing > start && /\s/.test(original.charAt(trailing - 1))) {
    trailing--;
  }

  const lineStart = original.lastIndexOf("\n", start) + 1;
  const indent = `${original.slice(lineStart, start).match(/^\s*/)?.[0] ?? ""}  `;
  const formatted = `${indent}${JSON.stringify(entry, null, 2).replaceAll("\n", `\n${indent}`)}`;
  const addition = `${original.slice(start + 1, trailing).trim() ? "," : ""}\n${formatted}`;

  return `${original.slice(0, trailing)}${addition}${original.slice(trailing)}`;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
