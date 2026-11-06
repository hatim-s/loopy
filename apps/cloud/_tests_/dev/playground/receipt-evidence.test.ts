import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeBoundary,
  finishedAttemptRecordSchema,
  sandboxAttemptIdentitySchema,
  sandboxExecutionResultSchema,
} from "@loopy/contract";
import { Effect } from "effect";
import { attemptHash } from "../../../../sandbox/src/admission";
import { receiptEvidence } from "../../../dev/playground/receipt/evidence";
import { decodeRuntimeQueue } from "../../../dev/playground/runtime-queue-schema";

// These are synthetic typed inputs. No receipt authority or workload is started.
const identity = decodeBoundary(sandboxAttemptIdentitySchema)({
  workspace: "playground",
  executionKey: { runId: "synthetic-run", nodeId: "0:code", scope: [] },
  attempt: 1,
});

const root = "/synthetic/runtime-root/.loopy/cloud/sandbox";

const id = attemptHash({ root, ...identity });

const result = decodeBoundary(sandboxExecutionResultSchema)({
  kind: "succeeded",
  output: { ok: true },
  logs: [],
});

const bytes = '{"kind":"succeeded","logs":[],"output":{"ok":true}}';

const ref = {
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: Buffer.byteLength(bytes),
};

const record = decodeBoundary(finishedAttemptRecordSchema)({
  kind: "finished",
  plan: {
    ...identity,
    id,
    requestHash: "c".repeat(64),
    container: `loopy-attempt-${id}`,
    inputVolume: `loopy-input-${id}`,
    volume: `loopy-workspace-${"d".repeat(64)}`,
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
  const queue = decodeRuntimeQueue(
    JSON.parse(
      JSON.stringify({
        executionKey: identity.executionKey,
        attempt: identity.attempt,
        queuedAt: "2026-11-05T00:00:00.000Z",
        acquiredAt: "2026-11-05T00:00:00.001Z",
        finishedAt: "2026-11-05T00:00:00.002Z",
        queueWaitMs: 1,
        backendDurationMs: 1,
        outcome: "succeeded",
      }),
    ),
  );

  const evidence = await Effect.runPromise(
    receiptEvidence({
      ...options(),
      identity: {
        workspace: identity.workspace,
        executionKey: queue.executionKey,
        attempt: queue.attempt,
      },
    }),
  );

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

  const corrupted = decodeBoundary(sandboxExecutionResultSchema)({
    ...result,
    output: { ok: false },
  });

  await expect(Effect.runPromise(receiptEvidence(options(corrupted)))).rejects.toThrow(
    "authoritative result reference",
  );
});
