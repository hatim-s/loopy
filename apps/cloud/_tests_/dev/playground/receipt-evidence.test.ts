import { expect, test } from "bun:test";
import { decodeBoundary, executionResultSchema } from "@loopy/contract";
import {
  attemptResources,
  finishedAttemptRecordSchema,
  resultBytes,
  resultRef,
  sandboxAttemptIdentitySchema,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { receiptEvidence } from "../../../dev/playground/receipt/evidence";

const identity = decodeBoundary(sandboxAttemptIdentitySchema)({
  workspace: "playground",
  executionKey: { runId: "synthetic-run", nodeId: "0:code", scope: [] },
  attempt: 1,
});

const root = "/synthetic/runtime-root/.loopy/cloud/sandbox";

const resources = await attemptResources(root, identity);

const { id } = resources;

const result = decodeBoundary(executionResultSchema)({
  kind: "succeeded",
  output: { ok: true },
  logs: [],
});

const bytes = resultBytes(result);

if (bytes === null) {
  throw new Error("The fixture result must fit the sandbox capture limit.");
}

const ref = await resultRef(bytes);

const record = decodeBoundary(finishedAttemptRecordSchema)({
  kind: "finished",
  plan: {
    ...identity,
    ...resources,
    requestHash: "c".repeat(64),
    deadline: 1,
  },
  session: { epoch: 1, nonce: "synthetic-session" },
  result: { kind: "blob", ref },
});

function options(value = result) {
  return {
    root,
    identity,
    authority: { read: () => Effect.succeed(record) },
    resultsFor: () => ({
      get: () => Effect.succeed(value),
      put: () => Effect.die(new Error("Evidence must never publish results.")),
    }),
  };
}

test("receipt evidence verifies immutable bytes and rejects wrong identities, inline and corrupt results", async () => {
  const evidence = await Effect.runPromise(receiptEvidence(options()));

  expect(evidence.id).toBe(id);
  expect(evidence.resultRef).toEqual(ref);
  expect(evidence.receiptMode).toBe("durable-object");
  await expect(
    Effect.runPromise(receiptEvidence({ ...options(), root: "/wrong-root" })),
  ).rejects.toThrow("execution identity");
  await expect(
    Effect.runPromise(
      receiptEvidence({
        ...options(),
        authority: {
          read: () =>
            Effect.succeed({ ...record, result: { kind: "inline" as const, value: result } }),
        },
      }),
    ),
  ).rejects.toThrow("immutable result bytes");

  const corrupted = decodeBoundary(executionResultSchema)({
    ...result,
    output: { ok: false },
  });

  await expect(Effect.runPromise(receiptEvidence(options(corrupted)))).rejects.toThrow(
    "authoritative result reference",
  );
});
