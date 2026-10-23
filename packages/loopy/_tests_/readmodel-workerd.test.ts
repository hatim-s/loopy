import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Miniflare } from "miniflare";
import { z } from "zod";
import { routes, runStatusSchema, statusCountsSchema } from "../src/contract/index.js";
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

const row = z.object({
  workspace: z.string(),
  slug: z.string(),
  status: runStatusSchema,
  count: z.number(),
});

const cursor = z.object({ cursor: z.number(), epoch: z.string() });

const schemaRows = z.array(
  z.object({ type: z.string(), name: z.string(), sql: z.string().nullable() }),
);

test("workerd grouped counts match per-filter queries through transitions, rollback and unchanged schema-15 reopening", async () => {
  const result = z
    .object({
      before: schemaRows,
      after: schemaRows,
      version: z.object({ value: z.literal("15") }),
      history: z.object({
        error: z.string().nullable(),
        before: cursor,
        after: cursor,
        snapshots: z.array(
          z.object({
            stage: z.string(),
            rows: z.array(row),
            global: statusCountsSchema,
            filters: z.array(
              z.object({ workspace: z.string(), slug: z.string(), counts: statusCountsSchema }),
            ),
          }),
        ),
      }),
    })
    .parse(await probe("/counts", "counts"));

  checkCountHistory(result.history, "Invalid time value");
  expect(result.after).toEqual(result.before);
  expect(result.version).toEqual({ value: "15" });
  expect(result.after.filter(({ type }) => type === "trigger")).toEqual([]);
  await runtime.unsafeEvictDurableObject("readmodel", "ReadmodelProbe", { name: "counts" });

  const reopened = z
    .object({ rows: z.array(row), cursor, version: z.object({ value: z.literal("15") }) })
    .parse(await probe("/reopen", "counts"));

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

    return routes.scopeItems.response.parse(await probe(`/scope?${params}`));
  });
});

test("negative control: workerd accepts old 97-index bindings and rejects old 98/200-index bindings", async () => {
  expect(await probe("/old?limit=97")).toEqual({ error: null });

  for (const limit of [98, 200]) {
    const result = z.object({ error: z.string() }).parse(await probe(`/old?limit=${limit}`));
    expect(result.error).toContain("too many SQL variables");
  }
});
