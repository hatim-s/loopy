import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ReceiptHarness, receiptHarness } from "./fixtures/receipt-harness.js";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function finished(runId: string) {
  const authority = harness.authority;

  const session = await authority.openSession({
    expectedEpoch: (await authority.status()).epoch,
    nonce: runId,
  });

  const plan = harness.plan(runId);
  await authority.admit({ session, plan });

  const result = await authority
    .resultsFor("alpha")
    .put({ kind: "succeeded", output: null, logs: [] });

  await authority.complete({ session, id: plan.id, requestHash: plan.requestHash, result });

  return { session, plan };
}

test("export guards exclude new same-volume admissions across restart and release under the current session", async () => {
  const { session, plan } = await finished("export");
  const request = { session, attemptId: plan.id, token: "export-guard" };
  const granted = await harness.authority.beginExport(request);
  expect(granted).toMatchObject({
    kind: "granted",
    record: { volume: plan.volume, helper: `loopy-artifact-${plan.id}`, session },
  });
  expect(await harness.authority.beginExport(request)).toEqual(granted);
  const next = harness.plan("export", 2);
  expect(await harness.authority.admit({ session, plan: next })).toEqual({
    kind: "rejected",
    code: "workspace_busy",
  });
  await harness.reopen();

  const successor = await harness.authority.openSession({
    expectedEpoch: session.epoch,
    nonce: "export-successor",
  });

  expect(await harness.authority.recoverable({ after: null, limit: 200 })).toMatchObject({
    exports: [{ token: request.token, session }],
  });
  await expect(
    harness.authority.endExport({ session, token: request.token }),
  ).rejects.toMatchObject({ code: "stale_session" });
  expect(await harness.authority.admit({ session: successor, plan: next })).toEqual({
    kind: "rejected",
    code: "workspace_busy",
  });
  expect(
    await harness.authority.admit({ session: successor, plan: harness.plan("other-volume") }),
  ).toMatchObject({ kind: "created" });
  // The test never creates a helper. The current trusted bridge may confirm that absence and release.
  await harness.authority.endExport({ session: successor, token: request.token });
  await harness.authority.endExport({ session: successor, token: request.token });
  expect(await harness.authority.beginExport({ ...request, session: successor })).toEqual({
    kind: "rejected",
    code: "invalid_state",
  });
  expect(await harness.authority.admit({ session: successor, plan: next })).toMatchObject({
    kind: "created",
  });
});

test("racing same-volume admission and export cannot both obtain authority", async () => {
  const { session, plan } = await finished("race");

  const [exported, admitted] = await Promise.all([
    harness.authority.beginExport({ session, attemptId: plan.id, token: "race-guard" }),
    harness.authority.admit({ session, plan: harness.plan("race", 2) }),
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

test("recoverable pagination has one stable combined limit over attempts and export guards", async () => {
  const { session, plan } = await finished("pagination");
  await harness.authority.beginExport({ session, attemptId: plan.id, token: "pagination-guard" });

  for (const name of ["page-a", "page-b", "page-c"]) {
    await harness.authority.admit({ session, plan: harness.plan(name) });
  }

  const all = await harness.authority.recoverable({ after: null, limit: 200 });
  const ids: string[] = [];
  let after: string | null = null;

  do {
    const page = await harness.authority.recoverable({ after, limit: 2 });

    const keys = [
      ...page.attempts.map((record) => `a:${record.plan.id}`),
      ...page.exports.map((record) => `e:${record.token}`),
    ];

    expect(keys.length).toBeLessThanOrEqual(2);
    ids.push(...keys);
    after = page.next;
  } while (after !== null);

  expect(ids).toEqual(
    [
      ...all.attempts.map((record) => `a:${record.plan.id}`),
      ...all.exports.map((record) => `e:${record.token}`),
    ].sort(),
  );
  expect(new Set(ids).size).toBe(ids.length);
});

test("export-only HTTP recovery filters an exact volume and excludes released guards", async () => {
  const { session, plan } = await finished("export-only");
  await harness.authority.beginExport({ session, attemptId: plan.id, token: "export-only-guard" });
  expect(
    await harness.authority.exportGuards({ after: null, limit: 1, volume: plan.volume }),
  ).toMatchObject({ exports: [{ token: "export-only-guard" }], next: null });
  expect(
    await harness.authority.exportGuards({
      after: "export-only-guard",
      limit: 1,
      volume: plan.volume,
    }),
  ).toEqual({ exports: [], next: null });
  await harness.authority.endExport({ session, token: "export-only-guard" });
  expect(
    await harness.authority.exportGuards({ after: null, limit: 1, volume: plan.volume }),
  ).toEqual({ exports: [], next: null });
});
