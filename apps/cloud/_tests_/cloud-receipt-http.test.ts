import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AUTHORITY_MAX_BODY_BYTES,
  RECEIPTS_NAMESPACE_HEADER,
  RECEIPTS_PATH,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import {
  bridgeToken,
  namespace,
  principalToken,
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

async function internal(
  options: {
    token?: string;
    namespace?: string;
    origin?: string;
    url?: string;
    body?: string;
    method?: string;
  } = {},
) {
  const headers = new Headers({
    Authorization: `Bearer ${options.token ?? bridgeToken}`,
    [RECEIPTS_NAMESPACE_HEADER]: options.namespace ?? namespace,
  });

  if (options.origin) {
    headers.set("Origin", options.origin);
  }

  const forwarder = await harness.runtime.getWorker("rollback");

  return forwarder.fetch("http://probe/forward", {
    method: "POST",
    body: JSON.stringify({
      url: options.url ?? `http://127.0.0.1${RECEIPTS_PATH}`,
      method: options.method ?? "POST",
      headers: Object.fromEntries(headers),
      body:
        options.method === "GET"
          ? undefined
          : (options.body ?? JSON.stringify({ operation: "status", input: {} })),
    }),
  });
}

test("internal routes separate bridge and principal credentials and reject namespace, origin and remote traffic", async () => {
  expect((await internal({ token: principalToken })).status).toBe(401);
  expect((await internal({ token: "invalid" })).status).toBe(401);
  expect((await internal({ namespace: "other-authority" })).status).toBe(403);
  expect((await internal({ origin: "http://127.0.0.1" })).status).toBe(403);
  expect((await internal({ url: `http://cloud.invalid${RECEIPTS_PATH}` })).status).toBe(403);
  expect((await internal({ url: `https://127.0.0.1${RECEIPTS_PATH}` })).status).toBe(403);
  expect((await internal({ method: "GET" })).status).toBe(405);
  expect((await internal()).status).toBe(200);
  expect(
    (
      await harness.runtime.dispatchFetch("http://127.0.0.1/api/cursor", {
        headers: { Authorization: `Bearer ${bridgeToken}` },
      })
    ).status,
  ).toBe(401);
});

test("malformed, extra-field and oversized commands cannot mutate the authority", async () => {
  const before = await Effect.runPromise(harness.authority.status({}));
  expect((await internal({ body: "" })).status).toBe(400);
  expect((await internal({ body: "{" })).status).toBe(400);
  expect(
    (
      await internal({
        body: JSON.stringify({
          operation: "openSession",
          input: { expectedEpoch: 0, nonce: "valid", extra: true },
        }),
      })
    ).status,
  ).toBe(400);
  expect((await internal({ body: "x".repeat(AUTHORITY_MAX_BODY_BYTES + 1) })).status).toBe(400);
  expect(await Effect.runPromise(harness.authority.status({}))).toEqual(before);
});

test("root-derived identities include ordered scope and cannot name another authority's Docker resources", async () => {
  const session = await Effect.runPromise(
    harness.authority.openSession({ expectedEpoch: 0, nonce: "identity" }),
  );

  const plan = await harness.plan("identity");
  expect(
    await Effect.runPromise(
      harness.authority.admit({
        session,
        plan: { ...plan, volume: `loopy-workspace-${"f".repeat(64)}` },
      }),
    ),
  ).toEqual({ kind: "rejected", code: "invalid_state" });
  expect(
    await Effect.runPromise(harness.authority.admit({ session, plan: { ...plan, attempt: 2 } })),
  ).toEqual({
    kind: "rejected",
    code: "invalid_state",
  });
  expect(await Effect.runPromise(harness.authority.read({ id: plan.id }))).toBeNull();
});

test("nonlocal stage and overlapping user/bridge credentials cannot open the internal authority", async () => {
  for (const configuration of [{ stage: "production" }, { token: principalToken }]) {
    const isolated = await receiptHarness(configuration);

    try {
      const response = await isolated.runtime.dispatchFetch(`http://127.0.0.1${RECEIPTS_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${principalToken}`,
          [RECEIPTS_NAMESPACE_HEADER]: namespace,
        },
        body: JSON.stringify({ operation: "status", input: {} }),
      });

      expect(response.status).toBe(configuration.stage ? 403 : 500);
    } finally {
      await isolated.close();
    }
  }
});
