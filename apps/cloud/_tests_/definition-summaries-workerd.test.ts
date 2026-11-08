import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { definitionSummarySchema, type PutLoopyBody } from "@loopy/contract";
import { revision } from "@loopy/core";
import { Schema } from "effect";
import type { Miniflare } from "miniflare";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import type { SummaryProbeRequest } from "./fixtures/summary-workerd";
import { probeRuntime } from "./fixtures/workerd-probe";

let runtime: Miniflare;

let harness: Awaited<ReturnType<typeof probeRuntime>>;

beforeAll(async () => {
  harness = await probeRuntime({
    entry: resolve(import.meta.dir, "fixtures/summary-workerd.ts"),
    name: "summary-tests",
    className: "SummaryProbe",
    r2: "BUCKET",
  });
  runtime = harness.runtime;
}, 60_000);

afterAll(async () => {
  await harness?.cleanup();
});

function probe(instance: string, input: SummaryProbeRequest) {
  return harness.probe(instance, { body: input });
}

const summaryResult = Schema.Struct({
  value: Schema.NullOr(definitionSummarySchema),
  graphReads: Schema.Number,
});

const pointer = Schema.Struct({
  revision: Schema.String,
  source: Schema.String,
  saved_at: Schema.String,
  generation: Schema.String,
  projection_json: Schema.NullOr(Schema.String),
});

const pointerResult = Schema.Struct({ value: pointer, graphReads: Schema.Number });

function fixture(description: string): Promise<PutLoopyBody> {
  return compiledBody("summary", "/entry.ts", { workspace: "summaries", description });
}

async function change(body: PutLoopyBody, description: string) {
  const changed = structuredClone(body);
  changed.graph.meta.description = description;
  changed.revision = await revision(changed.graph);

  return changed;
}

test("cloud SQL projections preserve legacy pointers and backfill outside transactions", async () => {
  const body = await fixture("legacy description");
  const result = await probe("legacy", { operation: "legacy", body });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    value: {
      columns: expect.not.arrayContaining([expect.objectContaining({ name: "projection_json" })]),
      projectionColumns: expect.arrayContaining([
        expect.objectContaining({ name: "projection_json", notnull: 1 }),
      ]),
      pointer: {
        generation: "legacy-generation",
        saved_at: "legacy-saved-at",
        projection_json: null,
      },
    },
    graphReads: 0,
  });

  const first = Schema.decodeUnknownSync(summaryResult)(
    (await probe("legacy", { operation: "summary" })).body,
  );

  expect(first).toMatchObject({
    value: {
      revision: body.revision,
      description: "legacy description",
      savedAt: "legacy-saved-at",
      input: {},
    },
    graphReads: 1,
  });
  expect(await probe("legacy", { operation: "summary" })).toEqual({
    status: 200,
    body: { value: first.value, graphReads: 0 },
  });
  await runtime.unsafeEvictDurableObject("summary-tests", "SummaryProbe", { name: "legacy" });
  expect(await probe("legacy", { operation: "list" })).toEqual({
    status: 200,
    body: { value: [first.value], graphReads: 0 },
  });
  expect(
    Schema.decodeUnknownSync(pointerResult)((await probe("legacy", { operation: "pointer" })).body)
      .value,
  ).toMatchObject({ saved_at: "legacy-saved-at", generation: "legacy-generation" });
});

test("same save repairs missing or corrupt summaries without changing generation or savedAt", async () => {
  const body = await fixture("same-save");

  const original = Schema.decodeUnknownSync(pointerResult)(
    (await probe("same", { operation: "save", body })).body,
  ).value;

  for (const operation of ["forget", "corruptSummary"] as const) {
    expect((await probe("same", { operation })).status).toBe(200);

    const repaired = Schema.decodeUnknownSync(pointerResult)(
      (await probe("same", { operation: "save", body })).body,
    ).value;

    expect(repaired).toEqual(original);
    expect(
      Schema.decodeUnknownSync(summaryResult)((await probe("same", { operation: "summary" })).body)
        .graphReads,
    ).toBe(0);
  }
});

for (const oldGraph of ["valid", "missing", "corrupt"] as const) {
  test(`a replacement save wins cold backfill against a ${oldGraph} old graph`, async () => {
    const body = await fixture("before-race");
    expect((await probe(`race-${oldGraph}`, { operation: "save", body })).status).toBe(200);
    expect((await probe(`race-${oldGraph}`, { operation: "forget" })).status).toBe(200);
    const bucket = await runtime.getR2Bucket("BUCKET");
    const key = `workspaces/summaries/graphs/${body.revision}.json`;

    if (oldGraph === "missing") {
      await bucket.delete(key);
    }

    if (oldGraph === "corrupt") {
      await bucket.put(key, "{invalid");
    }

    const changed = await change(body, "after-race");

    const response = await probe(`race-${oldGraph}`, { operation: "race", body: changed });
    expect(response).toMatchObject({ status: 200 });
    const raced = Schema.decodeUnknownSync(summaryResult)(response.body);

    expect(raced).toMatchObject({
      value: { description: "after-race", revision: changed.revision },
      graphReads: 1,
    });

    const saved = Schema.decodeUnknownSync(pointerResult)(
      (await probe(`race-${oldGraph}`, { operation: "pointer" })).body,
    ).value;

    expect(JSON.parse(saved.projection_json ?? "null")).toEqual({
      scope: raced.value?.scope,
      description: raced.value?.description,
      input: raced.value?.input,
      schedule: raced.value?.schedule,
      mode: raced.value?.mode,
    });
    expect(saved.revision).toBe(changed.revision);
  });
}

test("SQL failure rolls back the pointer, summary and generation together", async () => {
  const body = await fixture("before-rollback");
  expect((await probe("rollback", { operation: "save", body })).status).toBe(200);
  const changed = await change(body, "must-not-publish");

  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      value: Schema.Struct({ before: pointer, after: pointer, error: Schema.String }),
    }),
  )((await probe("rollback", { operation: "rollback", body: changed })).body);

  expect(result.value.error).toContain("CHECK constraint failed");
  expect(result.value.after).toEqual(result.value.before);
  expect(
    Schema.decodeUnknownSync(summaryResult)(
      (await probe("rollback", { operation: "summary" })).body,
    ).value?.description,
  ).toBe("before-rollback");
});

test("warm metadata endpoints read zero graphs while direct get, start and schedule reject corrupt artifacts", async () => {
  const body = await fixture("warm metadata");
  expect((await probe("warm", { operation: "save", body })).status).toBe(200);
  expect(await probe("warm", { operation: "start" })).toMatchObject({ status: 200 });
  const bucket = await runtime.getR2Bucket("BUCKET");
  await bucket.put(
    `workspaces/summaries/graphs/${body.revision}.json`,
    JSON.stringify({ ...body.graph, name: "corrupt" }),
  );
  expect(await probe("warm", { operation: "service" })).toMatchObject({
    status: 200,
    body: {
      value: {
        loopies: [{ description: "warm metadata", counts: { queued: 1 } }],
        runs: [{ loopy: { description: "warm metadata" } }],
      },
      graphReads: 0,
    },
  });

  for (const operation of ["get", "start", "schedule"] as const) {
    expect(await probe("warm", { operation })).toMatchObject({
      status: 400,
      body: {
        error:
          "Could not verify graph. Stored graph does not match its revision. Save the loopy again.",
        code: null,
        graphReads: 1,
      },
    });
  }

  expect(await probe("warm", { operation: "summary", slug: "absent" })).toEqual({
    status: 200,
    body: { value: null, graphReads: 0 },
  });

  expect(await probe("warm", { operation: "get", slug: "absent" })).toEqual({
    status: 200,
    body: { value: null, graphReads: 0 },
  });

  for (const operation of ["start", "schedule"] as const) {
    expect(await probe("warm", { operation, slug: "absent" })).toMatchObject({
      status: 400,
      body: { code: "not_found", graphReads: 0 },
    });
  }

  expect((await probe("warm", { operation: "forget" })).status).toBe(200);
  expect(await probe("warm", { operation: "list" })).toMatchObject({
    status: 400,
    body: {
      error:
        "Could not verify graph. Stored graph does not match its revision. Save the loopy again.",
      graphReads: 1,
    },
  });
});

for (const failure of ["missing", "corrupt"] as const) {
  test(`${failure} required graphs fail cold lists clearly without partial results`, async () => {
    const body = await fixture(`required-${failure}`);
    expect((await probe(failure, { operation: "save", body })).status).toBe(200);
    const bucket = await runtime.getR2Bucket("BUCKET");
    const key = `workspaces/summaries/graphs/${body.revision}.json`;

    if (failure === "missing") {
      await bucket.delete(key);
    } else {
      await bucket.put(key, "{invalid");
    }

    expect((await probe(failure, { operation: "forget" })).status).toBe(200);
    expect(await probe(failure, { operation: "list" })).toEqual({
      status: 400,
      body: {
        error:
          failure === "missing"
            ? "Could not read graph. Published graph is missing. Save the loopy again."
            : "Could not decode graph. Stored graph is invalid. Save the loopy again.",
        code: null,
        graphReads: 1,
      },
    });
  });
}
