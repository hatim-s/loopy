import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ReceiptHarness, receiptHarness } from "./fixtures/receipt-harness.js";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

test("real workerd recovery plans seek indexes through terminal and released history", async () => {
  const ns = await harness.runtime.getDurableObjectNamespace("PROBE", "rollback");

  const response = await ns.get(ns.idFromName("recovery")).fetch("http://probe/recovery", {
    method: "POST",
    body: JSON.stringify({
      session: { epoch: 1, nonce: "recovery" },
      plan: harness.plan("recovery"),
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    counts: {
      attempts: [{ kind: "finished", count: 1001 }],
      exports: [
        { active: 0, count: 1000 },
        { active: 1, count: 1 },
      ],
    },
    attempts: [
      {
        detail:
          "SEARCH receipt_attempts USING COVERING INDEX receipt_attempt_recovery (kind=? AND id>?)",
      },
    ],
    exports: [
      { detail: "SEARCH receipt_exports USING COVERING INDEX receipt_export_recovery (token>?)" },
    ],
    busy: [{ detail: "SEARCH receipt_exports USING INDEX receipt_export_volume (volume=?)" }],
    recovered: { attempts: [], exports: [{ token: "active" }], next: null },
    malformed: expect.stringContaining("Invalid"),
  });
});
