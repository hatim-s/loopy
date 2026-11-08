import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PutLoopyBody } from "@loopy/contract";
import { canonicalJson } from "@loopy/core";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { ARTIFACT_LIMITS } from "../src/artifacts";
import { mebibytes } from "../src/http";
import { type ArtifactRegistry, artifactRegistry } from "./fixtures/artifact-registry";

let registry: ArtifactRegistry;

beforeAll(async () => {
  registry = await artifactRegistry("artifact-capacity");
}, 60_000);

afterAll(async () => {
  await registry?.cleanup();
});

const call = (workspace: string, operation: string, ...args: unknown[]) =>
  registry.call(workspace, operation, ...args);

const definitionCapacity = expect.stringContaining(
  `${ARTIFACT_LIMITS.definitions} definition capacity`,
);

const capacityError = expect.stringContaining(
  `Workspace exceeds its ${mebibytes(ARTIFACT_LIMITS.listBytes)} current graph capacity. Replace a definition with a smaller graph before saving.`,
);

// Capacity counts canonical graph bytes, so expectations come from the same measure.
const graphBytes = (body: PutLoopyBody) =>
  new TextEncoder().encode(canonicalJson(body.graph)).length;

// Large descriptions fill the budget in a few dozen saves instead of thousands.
const large = "x".repeat(800_000);

const larger = "x".repeat(1_000_000);

const definition = (workspace: string, index: number, description?: string) =>
  compiledBody(`definition-${index}`, "/entry.ts", { workspace, description });

test("capacity rejects overflow without truncating list results", async () => {
  expect(await call("capacity", "fillCapacity", ARTIFACT_LIMITS.definitions)).toMatchObject({
    status: 200,
  });
  const body = await compiledBody("overflow", "/entry.ts", { workspace: "capacity" });
  expect(await call("capacity", "save", body)).toMatchObject({
    status: 400,
    body: { error: definitionCapacity },
  });
  expect(await call("overfull", "fillCapacity", ARTIFACT_LIMITS.definitions + 1)).toMatchObject({
    status: 200,
  });
  expect(await call("overfull", "listSummaries")).toMatchObject({
    status: 400,
    body: { error: definitionCapacity },
  });
});

test("aggregate capacity rejects new and replacement pointers while existing operations remain readable", async () => {
  const workspace = "aggregate";
  const first = await definition(workspace, 0, large);
  const fits = Math.floor(ARTIFACT_LIMITS.listBytes / graphBytes(first));
  const sizes: number[] = [];

  for (let index = 0; index < fits + 2; index++) {
    const body = await definition(workspace, index, large);
    expect(await call(workspace, "save", body)).toMatchObject(
      index < fits ? { status: 200 } : { status: 400, body: { error: capacityError } },
    );

    if (index < fits) {
      sizes.push(graphBytes(body));
    }
  }

  expect(await call(workspace, "listSizes")).toEqual({
    status: 200,
    body: { value: { count: fits, bounded: true } },
  });
  expect(await call(workspace, "get", `definition-${fits}`)).toEqual({
    status: 200,
    body: { value: null },
  });
  expect(await call(workspace, "get", first.graph.name)).toMatchObject({
    status: 200,
    body: { value: { revision: first.revision } },
  });

  // Each replacement grows one definition until the next growth would cross the budget.
  let used = sizes.reduce((sum, size) => sum + size, 0);
  let crossing = -1;

  for (let index = 0; crossing < 0; index++) {
    const replacement = await definition(workspace, index, larger);
    const grown = used + graphBytes(replacement) - (sizes[index] ?? 0);
    const accepted = grown <= ARTIFACT_LIMITS.listBytes;

    expect(await call(workspace, "save", replacement)).toMatchObject(
      accepted ? { status: 200 } : { status: 400, body: { error: capacityError } },
    );

    if (accepted) {
      used = grown;
    } else {
      crossing = index;
    }
  }

  expect(crossing).toBeGreaterThan(0);
  expect(await call(workspace, "get", `definition-${crossing}`)).toMatchObject({
    body: { value: { graph: { meta: { description: large } } } },
  });

  const equalReplacement = await definition(workspace, 0, "y".repeat(large.length));
  expect(await call(workspace, "save", equalReplacement)).toMatchObject({ status: 200 });
  expect(await call(workspace, "get", "definition-0")).toMatchObject({
    body: { value: { revision: equalReplacement.revision } },
  });
  expect(await call(workspace, "serviceChecks", "definition-0")).toMatchObject({
    status: 200,
    body: {
      value: {
        slug: "definition-0",
        revision: equalReplacement.revision,
        snapshotRead: true,
        scheduled: "definition-0",
        enabled: false,
        eventDelivered: true,
      },
    },
  });
  expect(await call(workspace, "save", await definition(workspace, 0))).toMatchObject({
    status: 200,
  });
  expect(await call(workspace, "save", await definition(workspace, fits, large))).toMatchObject({
    status: 200,
  });
  expect(await call(workspace, "listSizes")).toEqual({
    status: 200,
    body: { value: { count: fits + 1, bounded: true } },
  });
}, 60_000);

test("concurrent publications compete for aggregate capacity in the pointer transaction", async () => {
  const workspace = "aggregate-race";

  const fits = Math.floor(
    ARTIFACT_LIMITS.listBytes / graphBytes(await definition(workspace, 0, large)),
  );

  for (let index = 0; index < fits - 1; index++) {
    expect(await call(workspace, "save", await definition(workspace, index, large))).toMatchObject({
      status: 200,
    });
  }

  const contenders = await Promise.all(
    [fits - 1, fits].map((index) => definition(workspace, index, large)),
  );

  expect(await call(workspace, "race", ...contenders)).toEqual({
    status: 200,
    body: { value: expect.arrayContaining(["saved", capacityError]) },
  });
  expect(await call(workspace, "listSizes")).toMatchObject({
    status: 200,
    body: { value: { count: fits } },
  });
}, 60_000);

test("HTTP capacity rejection retains bad_request and an actionable message", async () => {
  const workspace = "capacity-http";
  expect((await call(workspace, "fillCapacity", ARTIFACT_LIMITS.definitions)).status).toBe(200);
  const body = await compiledBody("overflow", "/overflow.ts", { workspace });
  expect(await call(workspace, "httpSave", body)).toMatchObject({
    status: 400,
    body: {
      error: {
        code: "bad_request",
        message: definitionCapacity,
      },
    },
  });
});
