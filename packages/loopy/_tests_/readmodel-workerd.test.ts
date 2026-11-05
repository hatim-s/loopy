import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import type { Miniflare } from "miniflare";
import {
  decodeBoundary,
  routes,
  runStatusSchema,
  statusCountsSchema,
} from "../src/contract/index.js";
import { checkCountHistory, checkScopePages } from "./fixtures/readmodel-assertions.js";
import { probeRuntime } from "./fixtures/workerd-probe.js";

let runtime: Miniflare;

let harness: Awaited<ReturnType<typeof probeRuntime>>;

beforeAll(async () => {
  harness = await probeRuntime({
    entry: resolve(import.meta.dir, "fixtures/readmodel-workerd.ts"),
    name: "readmodel",
    className: "ReadmodelProbe",
  });
  runtime = harness.runtime;
}, 60_000);

afterAll(async () => {
  await harness?.cleanup();
});

async function probe(path: string, instance = "scopes") {
  const response = await harness.probe(instance, { path });
  expect(response).toMatchObject({ status: 200 });

  return response.body;
}

const row = Schema.Struct({
  workspace: Schema.String,
  slug: Schema.String,
  status: runStatusSchema,
  count: Schema.Number,
});

const cursor = Schema.Struct({ cursor: Schema.Number, epoch: Schema.String });

const schemaRows = Schema.Array(
  Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.NullOr(Schema.String) }),
);

test("workerd grouped counts match per-filter queries through transitions, rollback and unchanged schema-15 reopening", async () => {
  const resultSchema = Schema.Struct({
    before: schemaRows,
    after: schemaRows,
    version: Schema.Struct({ value: Schema.Literal("15") }),
    history: Schema.Struct({
      error: Schema.NullOr(Schema.String),
      before: cursor,
      after: cursor,
      snapshots: Schema.mutable(
        Schema.Array(
          Schema.Struct({
            stage: Schema.String,
            rows: Schema.mutable(Schema.Array(row)),
            global: statusCountsSchema,
            filters: Schema.mutable(
              Schema.Array(
                Schema.Struct({
                  workspace: Schema.String,
                  slug: Schema.String,
                  counts: statusCountsSchema,
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  });

  const result = decodeBoundary(resultSchema)(await probe("/counts", "counts"));

  checkCountHistory(
    result.history,
    "Invalid store timestamp 'invalid-timestamp'. Validate timestamps before persistence.",
  );
  expect(result.after).toEqual(result.before);
  expect(result.version).toEqual({ value: "15" });
  expect(result.after.filter(({ type }) => type === "trigger")).toEqual([]);
  await runtime.unsafeEvictDurableObject("readmodel", "ReadmodelProbe", { name: "counts" });

  const reopenedSchema = Schema.Struct({
    rows: Schema.mutable(Schema.Array(row)),
    cursor,
    version: Schema.Struct({ value: Schema.Literal("15") }),
  });

  const reopened = decodeBoundary(reopenedSchema)(await probe("/reopen", "counts"));

  expect(reopened.rows).toEqual(result.history.snapshots.at(-1)?.rows ?? []);
  expect(reopened.cursor).toEqual(result.history.after);
});

test("workerd scope pages keep numeric cursor traversal, status selection and all-status counts at 97/98/200", async () => {
  expect(await probe("/seed")).toEqual({ seeded: true });

  await checkScopePages(async (query) => {
    const params = new URLSearchParams({ limit: String(query.limit) });

    if (query.status !== undefined) {
      params.set("status", query.status);
    }

    if (query.after !== undefined) {
      params.set("after", String(query.after));
    }

    return decodeBoundary(routes.scopeItems.response)(await probe(`/scope?${params}`));
  });
});

test("negative control: workerd accepts old 97-index bindings and rejects old 98/200-index bindings", async () => {
  expect(await probe("/old?limit=97")).toEqual({ error: null });

  for (const limit of [98, 200]) {
    const result = decodeBoundary(Schema.Struct({ error: Schema.String }))(
      await probe(`/old?limit=${limit}`),
    );

    expect(result.error).toContain("too many SQL variables");
  }
});
