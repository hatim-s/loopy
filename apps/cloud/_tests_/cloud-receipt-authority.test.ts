import { afterAll, beforeAll, expect, test } from "bun:test";
import { decodeBoundary } from "@loopy/contract";
import { AuthorityError, authorityCommandSchema, RECEIPTS_PATH } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { HttpSandboxAuthority } from "../../sandbox/src/http-authority";
import {
  bridgeToken,
  namespace,
  type ReceiptHarness,
  receiptHarness,
} from "./fixtures/receipt-harness";

let harness: ReceiptHarness;

beforeAll(async () => {
  harness = await receiptHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function session(nonce: string) {
  return Effect.runPromise(
    harness.authority.openSession({
      expectedEpoch: (await Effect.runPromise(harness.authority.status({}))).epoch,
      nonce,
    }),
  );
}

test("actual workerd rolls back admission on a later SQLite constraint failure", async () => {
  const ns = await harness.runtime.getDurableObjectNamespace("PROBE", "rollback");

  const response = await ns.get(ns.idFromName("rollback")).fetch("http://probe/rollback", {
    method: "POST",
    body: JSON.stringify({
      session: { epoch: 1, nonce: "rollback" },
      plan: await harness.plan("rollback"),
    }),
  });

  expect(await response.json()).toMatchObject({
    failure: expect.stringContaining("UNIQUE constraint failed"),
    record: null,
    current: { epoch: 1, nonce: "rollback" },
  });
});

test("session CAS rejects delayed opens and stale writes; successor recovers the saved admitting session", async () => {
  const first = await session("first");
  const plan = await harness.plan("stale");
  await Effect.runPromise(harness.authority.admit({ session: first, plan }));
  expect(
    await Effect.runPromise(
      harness.authority.openSession({ expectedEpoch: 0, nonce: first.nonce }),
    ),
  ).toEqual(first);
  const second = await session("second");
  await expect(
    Effect.runPromise(
      harness.authority.openSession({ expectedEpoch: first.epoch, nonce: "delayed" }),
    ),
  ).rejects.toMatchObject({ code: "stale_session" });
  await expect(
    Effect.runPromise(
      harness.authority.openSession({ expectedEpoch: second.epoch, nonce: first.nonce }),
    ),
  ).rejects.toBeInstanceOf(AuthorityError);
  expect(await Effect.runPromise(harness.authority.admit({ session: first, plan }))).toEqual({
    kind: "rejected",
    code: "stale_session",
  });

  const ref = await Effect.runPromise(
    harness.authority.resultsFor("alpha").put({ kind: "succeeded", output: "done", logs: [] }),
  );

  expect(
    await Effect.runPromise(
      harness.authority.complete({
        session: first,
        id: plan.id,
        requestHash: plan.requestHash,
        result: ref,
      }),
    ),
  ).toEqual({ kind: "rejected", code: "stale_session" });
  expect(
    await Effect.runPromise(
      harness.authority.complete({
        session: second,
        id: "f".repeat(64),
        requestHash: plan.requestHash,
        result: ref,
      }),
    ),
  ).toEqual({ kind: "rejected", code: "missing" });
  expect(
    await Effect.runPromise(
      harness.authority.complete({
        session: second,
        id: plan.id,
        requestHash: "b".repeat(64),
        result: ref,
      }),
    ),
  ).toEqual({ kind: "rejected", code: "request_conflict" });
  expect(
    await Effect.runPromise(
      harness.authority.complete({
        session: second,
        id: plan.id,
        requestHash: plan.requestHash,
        result: ref,
      }),
    ),
  ).toMatchObject({ kind: "finished", record: { session: first } });
});

test("lost admission/completion responses survive full workerd reconstruction without creating a second grant", async () => {
  const current = await session("lost-response");
  const plan = await harness.plan("lost-response");
  const drops = new Set(["admit", "complete"]);
  let readUnavailable = true;

  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const command = decodeBoundary(authorityCommandSchema)(JSON.parse(body));

      if (command.operation === "read" && readUnavailable) {
        readUnavailable = false;

        return new Response(null, { status: 503 });
      }

      const response = await fetch(new URL(RECEIPTS_PATH, harness.origin), {
        method: "POST",
        headers: request.headers,
        body,
      });

      if (drops.delete(command.operation)) {
        await response.body?.cancel();

        return new Response(null, { status: 503 });
      }

      return response;
    },
  });

  const ambiguous = new HttpSandboxAuthority({
    url: proxy.url.origin,
    token: bridgeToken,
    namespace,
  });

  try {
    await expect(Effect.runPromise(ambiguous.admit({ session: current, plan }))).rejects.toThrow(
      "HTTP 503",
    );
    await expect(Effect.runPromise(ambiguous.read({ id: plan.id }))).rejects.toThrow("HTTP 503");
    await harness.reopen();
    expect(await Effect.runPromise(harness.authority.read({ id: plan.id }))).toEqual({
      kind: "started",
      plan,
      session: current,
    });
    expect(
      await Effect.runPromise(harness.authority.admit({ session: current, plan })),
    ).toMatchObject({
      kind: "existing",
    });

    const ref = await Effect.runPromise(
      harness.authority
        .resultsFor("alpha")
        .put({ kind: "succeeded", output: "retained", logs: [] }),
    );

    await expect(
      Effect.runPromise(
        ambiguous.complete({
          session: current,
          id: plan.id,
          requestHash: plan.requestHash,
          result: ref,
        }),
      ),
    ).rejects.toThrow("HTTP 503");
    await harness.reopen();
    expect(
      await Effect.runPromise(
        harness.authority.complete({
          session: current,
          id: plan.id,
          requestHash: plan.requestHash,
          result: ref,
        }),
      ),
    ).toMatchObject({ kind: "finished", record: { plan, result: { kind: "blob", ref } } });
    expect(await Effect.runPromise(harness.authority.resultsFor("alpha").get(ref))).toEqual({
      kind: "succeeded",
      output: "retained",
      logs: [],
    });

    const other = await Effect.runPromise(
      harness.authority.resultsFor("alpha").put({ kind: "succeeded", output: "changed", logs: [] }),
    );

    expect(
      await Effect.runPromise(
        harness.authority.complete({
          session: current,
          id: plan.id,
          requestHash: plan.requestHash,
          result: other,
        }),
      ),
    ).toEqual({ kind: "rejected", code: "request_conflict" });
  } finally {
    await proxy.stop(true);
  }
});
