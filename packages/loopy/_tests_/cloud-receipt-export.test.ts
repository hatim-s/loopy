import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { type ReceiptHarness, receiptHarness } from "./fixtures/receipt-harness";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

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

test("export guards exclude new same-volume admissions across restart and release under the current session", async () => {
  const { session, plan } = await finished("export");
  const request = { session, attemptId: plan.id, token: "export-guard" };
  const granted = await Effect.runPromise(harness.authority.beginExport(request));
  expect(granted).toMatchObject({
    kind: "granted",
    record: { volume: plan.volume, helper: `loopy-artifact-${plan.id}`, session },
  });
  expect(await Effect.runPromise(harness.authority.beginExport(request))).toEqual(granted);
  const next = await harness.plan("export", 2);
  expect(await Effect.runPromise(harness.authority.admit({ session, plan: next }))).toEqual({
    kind: "rejected",
    code: "workspace_busy",
  });
  await harness.reopen();

  const successor = await Effect.runPromise(
    harness.authority.openSession({
      expectedEpoch: session.epoch,
      nonce: "export-successor",
    }),
  );

  expect(
    await Effect.runPromise(harness.authority.recoverable({ after: null, limit: 200 })),
  ).toMatchObject({
    exports: [{ token: request.token, session }],
  });
  await expect(
    Effect.runPromise(harness.authority.endExport({ session, token: request.token })),
  ).rejects.toMatchObject({ code: "stale_session" });
  expect(
    await Effect.runPromise(harness.authority.admit({ session: successor, plan: next })),
  ).toEqual({
    kind: "rejected",
    code: "workspace_busy",
  });
  expect(
    await Effect.runPromise(
      harness.authority.admit({ session: successor, plan: await harness.plan("other-volume") }),
    ),
  ).toMatchObject({ kind: "created" });
  // The test never creates a helper. The current trusted bridge may confirm that absence and release.
  await Effect.runPromise(
    harness.authority.endExport({ session: successor, token: request.token }),
  );
  await Effect.runPromise(
    harness.authority.endExport({ session: successor, token: request.token }),
  );
  expect(
    await Effect.runPromise(harness.authority.beginExport({ ...request, session: successor })),
  ).toEqual({
    kind: "rejected",
    code: "invalid_state",
  });
  expect(
    await Effect.runPromise(harness.authority.admit({ session: successor, plan: next })),
  ).toMatchObject({
    kind: "created",
  });
});

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

test("recoverable pagination has one stable combined limit over attempts and export guards", async () => {
  const { session, plan } = await finished("pagination");
  await Effect.runPromise(
    harness.authority.beginExport({ session, attemptId: plan.id, token: "pagination-guard" }),
  );

  for (const name of ["page-a", "page-b", "page-c"]) {
    await Effect.runPromise(harness.authority.admit({ session, plan: await harness.plan(name) }));
  }

  const all = await Effect.runPromise(harness.authority.recoverable({ after: null, limit: 200 }));
  const ids: string[] = [];
  let after: string | null = null;

  do {
    const page: typeof all = await Effect.runPromise(
      harness.authority.recoverable({ after, limit: 2 }),
    );

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
  await Effect.runPromise(
    harness.authority.beginExport({ session, attemptId: plan.id, token: "export-only-guard" }),
  );
  expect(
    await Effect.runPromise(
      harness.authority.exportGuards({ after: null, limit: 1, volume: plan.volume }),
    ),
  ).toMatchObject({ exports: [{ token: "export-only-guard" }], next: null });
  expect(
    await Effect.runPromise(
      harness.authority.exportGuards({
        after: "export-only-guard",
        limit: 1,
        volume: plan.volume,
      }),
    ),
  ).toEqual({ exports: [], next: null });
  await Effect.runPromise(harness.authority.endExport({ session, token: "export-only-guard" }));
  expect(
    await Effect.runPromise(
      harness.authority.exportGuards({ after: null, limit: 1, volume: plan.volume }),
    ),
  ).toEqual({ exports: [], next: null });
});
