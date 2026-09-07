import { expect, test } from "bun:test";
import {
  decodeTraceJsonl,
  decodeTraceJsonlStream,
  encodeTraceJsonl,
  encodeTraceJsonlStream,
} from "../src/index.ts";

const fixture = decodeTraceJsonl(
  await Bun.file(new URL("../fixtures/trace.jsonl", import.meta.url)).text(),
).events;
test("ordered encoder yields before requesting the remaining source", async () => {
  let requested = false;
  async function* source() {
    const first = fixture[0];
    const second = fixture[1];
    if (!first || !second) throw new Error("Fixture events missing");
    yield first;
    requested = true;
    yield second;
  }
  const stream = encodeTraceJsonlStream(source(), { ordered: true });
  expect((await stream.next()).done).toBe(false);
  expect(requested).toBe(false);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(requested).toBe(true);
});
test("incremental decoder preserves tolerant diagnostics and UTF8 boundaries", async () => {
  for (const text of [
    encodeTraceJsonl(fixture),
    fixture
      .map((e) => JSON.stringify(e))
      .reverse()
      .join("\n"),
    "\n",
    "\n\n",
    `${JSON.stringify(fixture[0])}\n{`,
    `${JSON.stringify(fixture[1])}\n${JSON.stringify(fixture[1])}\n`,
  ]) {
    const bytes = new TextEncoder().encode(text);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    expect(await decodeTraceJsonlStream(chunks, { rejectDiagnostics: false })).toEqual(
      decodeTraceJsonl(text, { rejectDiagnostics: false }),
    );
  }
});

test("string chunk surrogate boundaries and strict diagnostic precedence match synchronous decode", async () => {
  const first = fixture[1];
  if (!first) throw new Error("fixture missing");
  const text = JSON.stringify({ ...first, payload: { ...first.payload, content: "hi😀" } });
  const cut = text.indexOf("😀") + 1;
  expect(await decodeTraceJsonlStream([text.slice(0, cut), text.slice(cut)])).toEqual(
    decodeTraceJsonl(text),
  );
  for (const policy of ["required", "forbidden"] as const) {
    for (const value of ["{", "\n\n", "{\n"]) {
      let expected: unknown;
      try {
        decodeTraceJsonl(value, { trailingNewlinePolicy: policy });
      } catch (error) {
        expected = error;
      }
      await expect(
        decodeTraceJsonlStream([value], { trailingNewlinePolicy: policy }),
      ).rejects.toMatchObject({ diagnostics: (expected as { diagnostics: unknown }).diagnostics });
    }
  }
});
