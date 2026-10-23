import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attemptHash } from "../../../apps/sandbox/src/admission.js";
import {
  finishedAttemptRecordSchema,
  sandboxAttemptIdentitySchema,
  sandboxExecutionResultSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { receiptEvidence } from "../receipt-evidence.js";

// These are synthetic typed inputs. No receipt authority or workload is started.
const identity = sandboxAttemptIdentitySchema.parse({
  workspace: "playground",
  executionKey: { runId: "synthetic-run", nodeId: "0:code", scope: [] },
  attempt: 1,
});

const root = "/synthetic/runtime-root/.loopy/cloud/sandbox";

const id = attemptHash({ root, ...identity });

const result = sandboxExecutionResultSchema.parse({
  kind: "succeeded",
  output: { ok: true },
  logs: [],
});

const bytes = '{"kind":"succeeded","logs":[],"output":{"ok":true}}';

const ref = {
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: Buffer.byteLength(bytes),
};

const record = finishedAttemptRecordSchema.parse({
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
    authority: { read: async () => record },
    resultsFor: () => ({
      get: async () => value,
      put: async () => {
        throw new Error("Evidence must never publish results.");
      },
    }),
  };
}

test("receipt evidence verifies immutable bytes and rejects wrong identities, inline and corrupt results", async () => {
  const evidence = await receiptEvidence(options());
  expect(evidence.id).toBe(id);
  expect(evidence.resultRef).toEqual(ref);
  expect(evidence.receiptMode).toBe("durable-object");
  await expect(receiptEvidence({ ...options(), root: "/wrong-root" })).rejects.toThrow(
    "execution identity",
  );
  await expect(
    receiptEvidence({
      ...options(),
      authority: { read: async () => ({ ...record, result: { kind: "inline", value: result } }) },
    }),
  ).rejects.toThrow("immutable result bytes");
  const corrupted = sandboxExecutionResultSchema.parse({ ...result, output: { ok: false } });
  await expect(receiptEvidence(options(corrupted))).rejects.toThrow(
    "authoritative result reference",
  );
});
