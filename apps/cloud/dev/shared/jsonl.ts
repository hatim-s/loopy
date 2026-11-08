import { boundaryOptions } from "@loopy/contract";
import { Result, Schema } from "effect";

/**
 * Decodes one JSON value per line. A tolerant read counts lines that fail to parse or decode,
 * because a writer may still be appending the last one; a strict read throws on the first.
 */
export function parseJsonLines<S extends Schema.Codec<unknown, unknown, never, never>>(
  text: string,
  schema: S,
  mode: "strict" | "tolerant",
) {
  const decode = Schema.decodeUnknownResult(schema, boundaryOptions);
  const values: S["Type"][] = [];
  let invalid = 0;

  for (const line of text.split("\n").filter((value) => value.trim().length > 0)) {
    const decoded = Result.flatMap(
      Result.try({ try: () => JSON.parse(line), catch: () => undefined }),
      (value) => decode(value),
    );

    if (Result.isSuccess(decoded)) {
      values.push(decoded.success);
    } else if (mode === "strict") {
      throw new Error("A JSONL record does not match its schema. Inspect the journal file.");
    } else {
      invalid++;
    }
  }

  return { values, invalid };
}

/** A missing file holds no records yet. */
export async function readJsonLines<S extends Schema.Codec<unknown, unknown, never, never>>(
  path: string,
  schema: S,
  mode: "strict" | "tolerant",
) {
  const file = Bun.file(path);

  return parseJsonLines((await file.exists()) ? await file.text() : "", schema, mode);
}
