import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import type { ExecutionResult } from "../src";
import { authorityCommandSchema, resultBytes, resultRef } from "../src/sandbox";

const successful: ExecutionResult = { kind: "succeeded", output: { ok: true }, logs: [] };

test("wire operations reject missing admitting sessions and unscoped results", async () => {
  const bytes = resultBytes(successful);

  if (bytes === null) {
    throw new Error("Fixture result exceeds the capture limit.");
  }

  for (const command of [
    { operation: "resultPut", input: { value: successful } },
    { operation: "resultGet", input: { ref: await resultRef(bytes) } },
    { operation: "admit", input: { plan: {} } },
  ]) {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(authorityCommandSchema, { onExcessProperty: "error" })(command),
      ),
    ).toBe(true);
  }
});
