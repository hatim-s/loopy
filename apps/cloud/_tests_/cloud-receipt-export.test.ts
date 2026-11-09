import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { authorityContract } from "../../sandbox/_tests_/fixtures/authority-contract";
import { type ReceiptHarness, receiptHarness } from "./fixtures/receipt-harness";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

// Registered first, so the restart and paging assertions run before other tests add history.
authorityContract("Durable Object", async () => ({
  get authority() {
    return harness.authority;
  },
  resultsFor: (workspace) => harness.authority.resultsFor(workspace),
  plan: (runId, attempt) => harness.plan(runId, attempt),
  restart: () => harness.reopen(),
}));

async function finished(runId: string) {
  const authority = harness.authority;

  const session = await Effect.runPromise(
    authority.openSession({
      expectedEpoch: (await Effect.runPromise(authority.status({}))).epoch,
      nonce: runId,
    }),
  );

  const plan = await harness.plan(runId);
  await Effect.runPromise(authority.admit({ session, plan }));

  const result = await Effect.runPromise(
    authority.resultsFor("alpha").put({ kind: "succeeded", output: null, logs: [] }),
  );

  await Effect.runPromise(
    authority.complete({ session, id: plan.id, requestHash: plan.requestHash, result }),
  );

  return { session, plan };
}

test("racing same-volume admission and export cannot both obtain authority", async () => {
  const { session, plan } = await finished("race");

  const [exported, admitted] = await Promise.all([
    Effect.runPromise(
      harness.authority.beginExport({ session, attemptId: plan.id, token: "race-guard" }),
    ),
    Effect.runPromise(harness.authority.admit({ session, plan: await harness.plan("race", 2) })),
  ]);

  expect([exported.kind, admitted.kind].sort()).toEqual(
    exported.kind === "granted" ? ["granted", "rejected"] : ["created", "rejected"],
  );

  if (exported.kind === "granted") {
    expect(admitted).toEqual({ kind: "rejected", code: "workspace_busy" });
  } else {
    expect(exported).toEqual({ kind: "rejected", code: "workspace_busy" });
  }
});

test("real workerd recovery pages skip terminal attempts and released export history", async () => {
  const ns = await harness.runtime.getDurableObjectNamespace("PROBE", "rollback");

  const response = await ns.get(ns.idFromName("recovery")).fetch("http://probe/recovery", {
    method: "POST",
    body: JSON.stringify({
      session: { epoch: 1, nonce: "recovery" },
      plan: await harness.plan("recovery"),
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    recovered: { attempts: [], exports: [{ token: "active" }], next: null },
    malformed: expect.stringContaining('Expected { "kind": "started"'),
    exactVolume: { exports: [{ token: "active" }], next: null },
    otherVolume: { exports: [], next: null },
  });
});
