import { expect, test } from "bun:test";
import type { AdmissionResult, WorkflowVersion } from "../src/application/ports.js";
import { createControlHandler } from "../src/cloud/api.js";
import { HostedControl, type TenantControl, type VerifiedPrincipal } from "../src/cloud/control.js";
import {
  type DispatchDelivery,
  type DurableDriver,
  dispatchPending,
  type OutboxStore,
} from "../src/cloud/dispatch.js";
import type { DurableRunState } from "../src/runtime/transition-store.js";

const runtime = { build: "test", graphSchema: 1 } as const;
const principal: VerifiedPrincipal = {
  subject: "user",
  tenantId: "a",
  operations: ["read", "run", "cancel"],
};
function fixture() {
  const tenants = new Map<
    string,
    { services: TenantControl; states: Map<string, DurableRunState> }
  >();
  const driver: DurableDriver = {
    ensureStarted: async () => {},
    cancel: async () => {
      throw new Error("offline");
    },
  };
  const control = new HostedControl(
    ({ tenantId }) => {
      const existing = tenants.get(tenantId);
      if (existing) return existing.services;
      const scope = { tenantId };
      const states = new Map<string, DurableRunState>();
      const admissions = new Map<string, { fingerprint: string; result: AdmissionResult }>();
      const version: WorkflowVersion = {
        id: "v1",
        slug: "hello",
        workflow: {
          version: 1,
          slug: "hello",
          nodes: [{ id: "hello", kind: "command", command: { program: "echo", args: [] } }],
        },
        graphHash: "hash",
        files: [],
        entrypoint: "index.ts",
        compiler: "test",
        runtime,
        imageDigest: "sha256:image",
      };
      const services: TenantControl = {
        catalog: {
          scope,
          getVersion: async (id) => (id === "v1" ? version : undefined),
          publish: async (value) => value,
        },
        admission: {
          scope,
          admit: async (request, run, dispatch) => {
            const previous = admissions.get(request.idempotencyKey);
            if (previous)
              return previous.fingerprint === request.fingerprint
                ? ({ ...previous.result, state: "existing" } as AdmissionResult)
                : { state: "conflict" };
            states.set(run.id, {
              revision: 0,
              run,
              attempts: [],
              workspace: { state: "unallocated" },
              cancelRequested: false,
            });
            const result: AdmissionResult = { state: "created", run, dispatch };
            admissions.set(request.idempotencyKey, { fingerprint: request.fingerprint, result });
            return result;
          },
        },
        runs: {
          scope,
          read: async (id) => states.get(id),
          acquire: async () => undefined,
          commit: async () => false,
          release: async () => {},
          requestCancel: async (id) => {
            const state = states.get(id);
            if (state) state.cancelRequested = true;
          },
        },
      };
      tenants.set(tenantId, { services, states });
      return services;
    },
    driver,
    { protocol: 1, runtime, operations: ["read", "run", "cancel"], executors: ["fake"] },
  );
  return { control, tenants };
}

test("tenant isolation and canonical manual admission idempotency", async () => {
  const { control } = fixture();
  const first = await control.admit(principal, {
    versionId: "v1",
    idempotencyKey: "key",
    input: { a: 1, b: 2 },
  });
  if (first.state === "conflict") throw new Error("unexpected conflict");
  const repeated = await control.admit(principal, {
    versionId: "v1",
    idempotencyKey: "key",
    input: { b: 2, a: 1 },
  });
  expect(repeated).toMatchObject({ state: "existing", run: { id: first.run.id } });
  await expect(
    control.admit(principal, { versionId: "v1", idempotencyKey: "key", input: 3 }),
  ).rejects.toMatchObject({ status: 409 });
  const other = { ...principal, tenantId: "b" };
  await expect(control.inspect(other, first.run.id)).rejects.toMatchObject({ status: 404 });
  await expect(control.cancel(other, first.run.id)).rejects.toMatchObject({ status: 404 });
  const otherRun = await control.admit(other, { versionId: "v1", idempotencyKey: "key", input: 3 });
  expect(otherRun.state).toBe("created");
});

test("cancellation survives unavailable host and capability denial precedes mutation", async () => {
  const { control, tenants } = fixture();
  const result = await control.admit(principal, {
    versionId: "v1",
    idempotencyKey: "key",
    input: null,
  });
  if (result.state === "conflict") throw new Error("unexpected conflict");
  await expect(
    control.cancel({ ...principal, operations: ["read"] }, result.run.id),
  ).rejects.toMatchObject({ status: 403 });
  expect(tenants.get("a")?.states.get(result.run.id)?.cancelRequested).toBe(false);
  await control.cancel(principal, result.run.id);
  expect(tenants.get("a")?.states.get(result.run.id)?.cancelRequested).toBe(true);
});

test("HTTP boundary rejects tenant and fingerprint injection, caps bodies and hides auth errors", async () => {
  const { control } = fixture();
  const handler = createControlHandler(control, async () => principal, { maxBodyBytes: 150 });
  for (const extra of [{ tenantId: "b" }, { fingerprint: "forged" }]) {
    const response = await handler(
      new Request("https://api.test/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: "v1", input: null, idempotencyKey: "key", ...extra }),
      }),
    );
    expect(response.status).toBe(400);
  }
  const oversized = await handler(
    new Request("https://api.test/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(151),
    }),
  );
  expect(oversized.status).toBe(413);
  const unauthenticated = createControlHandler(control, async () => {
    throw new Error("secret");
  });
  const denied = await unauthenticated(new Request("https://api.test/capabilities"));
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain("secret");
});

test("lost dispatch acknowledgement reconciles same run and stale claims cannot acknowledge", async () => {
  const delivery: DispatchDelivery = {
    kind: "start",
    id: "d",
    runId: "r",
    runtime,
    leaseToken: "",
  };
  let ack = false;
  let starts = 0;
  const coordinators = new Set<string>();
  const store: OutboxStore = {
    scope: { tenantId: "a" },
    claimDispatch: async (token) => [{ ...delivery, leaseToken: token }],
    ackDispatch: async () => ack,
    retryDispatch: async () => true,
  };
  const driver: DurableDriver = {
    ensureStarted: async (scope, id) => {
      starts++;
      coordinators.add(`${scope.tenantId}/${id}`);
    },
    cancel: async () => {},
  };
  expect(await dispatchPending(store, driver)).toEqual({ delivered: 0, retried: 0, stale: 1 });
  ack = true;
  expect(await dispatchPending(store, driver)).toEqual({ delivered: 1, retried: 0, stale: 0 });
  expect(starts).toBe(2);
  expect(coordinators.size).toBe(1);
  driver.ensureStarted = async () => {
    throw new Error("secret");
  };
  expect(await dispatchPending(store, driver)).toEqual({ delivered: 0, retried: 1, stale: 0 });
});

test("outbox cancellation reaches driver before a delayed start and failed delivery stays retryable", async () => {
  const seen: string[] = [];
  let failed = true;
  const store: OutboxStore = {
    scope: { tenantId: "a" },
    claimDispatch: async (token) => [
      { kind: "cancel", id: "cancel", runId: "r", runtime, leaseToken: token },
      { kind: "start", id: "start", runId: "r", runtime, leaseToken: token },
    ],
    ackDispatch: async (id) => {
      seen.push(`ack:${id}`);
      return true;
    },
    retryDispatch: async (id, _token, error) => {
      seen.push(`retry:${id}:${error}`);
      return true;
    },
  };
  const driver: DurableDriver = {
    cancel: async () => {
      seen.push("cancel");
      if (failed) throw new Error("provider secret");
    },
    ensureStarted: async () => {
      seen.push("start");
    },
  };
  expect(await dispatchPending(store, driver)).toEqual({ delivered: 1, retried: 1, stale: 0 });
  expect(seen).toEqual([
    "cancel",
    "retry:cancel:Coordinator dispatch failed",
    "start",
    "ack:start",
  ]);
  failed = false;
  seen.length = 0;
  expect(await dispatchPending(store, driver)).toEqual({ delivered: 2, retried: 0, stale: 0 });
  expect(seen).toEqual(["cancel", "ack:cancel", "start", "ack:start"]);
});
