import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { ARTIFACT_LIMITS } from "../../../apps/cloud/src/artifacts-storage.js";
import { definitionSummarySchema } from "../src/contract/index.js";
import { canonicalJson, revision } from "../src/core/index.js";
import { fillBytes, summarySizeBody, utf8 } from "./fixtures/summary-size-body.js";
import { summarySizeRuntime } from "./fixtures/summary-size-runtime.js";

let harness: Awaited<ReturnType<typeof summarySizeRuntime>>;

beforeAll(async () => {
  harness = await summarySizeRuntime();
}, 60_000);

afterAll(async () => {
  await harness?.cleanup();
});

const summary = z.object({
  value: definitionSummarySchema,
  graphReads: z.number(),
  artifactWrites: z.number(),
});

const inspect = z.object({
  value: z.object({
    pointer: z.object({
      generation: z.string(),
      saved_at: z.string(),
      revision: z.string(),
      sourceBytes: z.number(),
    }),
    projection: z.object({ generation: z.string(), projection_json: z.string() }).nullable(),
    pointerColumns: z.array(z.string()),
  }),
});

const pointerBudgetSourceBytes =
  ARTIFACT_LIMITS.metadataRowBytes - utf8("summaries") - utf8("summary") - 64 - 36 - 27;

for (const sourceBytes of [1_100_001, ARTIFACT_LIMITS.metadataRowBytes + 300]) {
  test(`legacy ${sourceBytes}-byte source remains readable with maximum graph metadata`, async () => {
    const instance = `legacy-${sourceBytes}`;
    const body = await summarySizeBody(`/${"x".repeat(sourceBytes - 1)}`);
    expect(utf8(canonicalJson(body.graph))).toBe(ARTIFACT_LIMITS.graphBytes);
    const legacy = await harness.probe(instance, { operation: "legacy", body });
    expect(legacy).toMatchObject({ status: 200 });

    const before = z
      .object({
        value: z.object({ pointer: inspect.shape.value.shape.pointer, projection: z.null() }),
      })
      .parse(legacy.body).value;

    const response = await harness.probe(instance, { operation: "summary" });
    expect(response).toMatchObject({ status: 200 });
    const first = summary.parse(response.body);
    expect(first).toMatchObject({
      value: {
        source: body.source.path,
        description: body.graph.meta.description,
        input: body.graph.input,
      },
      graphReads: 1,
      artifactWrites: 0,
    });
    expect(await harness.probe(instance, { operation: "list" })).toEqual({
      status: 200,
      body: { value: [first.value], graphReads: 0, artifactWrites: 0 },
    });
    expect(await harness.probe(instance, { operation: "service" })).toMatchObject({
      status: 200,
      body: {
        value: {
          loopies: [{ description: body.graph.meta.description }],
          runs: [{ loopy: { description: body.graph.meta.description } }],
        },
        graphReads: 0,
        artifactWrites: 0,
      },
    });
    await harness.evict(instance);
    expect(summary.parse((await harness.probe(instance, { operation: "summary" })).body)).toEqual({
      ...first,
      graphReads: 0,
    });

    const after = inspect.parse(
      (await harness.probe(instance, { operation: "inspect" })).body,
    ).value;

    expect(after.pointer).toEqual(before.pointer);

    if (sourceBytes > pointerBudgetSourceBytes) {
      expect(await harness.probe(instance, { operation: "save", body })).toEqual({
        status: 400,
        body: {
          error:
            "Definition source metadata exceeds the cloud SQL row byte budget. Shorten its source path before saving.",
          graphReads: 0,
          artifactWrites: 0,
        },
      });
      expect(summary.parse((await harness.probe(instance, { operation: "summary" })).body)).toEqual(
        { ...first, graphReads: 0 },
      );
    }

    expect(after.pointerColumns).not.toContain("summary_json");
    expect(after.projection?.generation).toBe(before.pointer.generation);
    const projection = JSON.parse(after.projection?.projection_json ?? "null");
    expect(Object.keys(projection).sort()).toEqual([
      "description",
      "input",
      "mode",
      "schedule",
      "scope",
    ]);
  });
}

for (const [name, pattern] of [
  ["ASCII", "x"],
  ["escaping", '\u0000"\\'],
  ["multibyte", "🧪"],
] as const) {
  test(`new ${name} source and maximum escaped graph fields fit separate SQL row budgets`, async () => {
    const source = `/${fillBytes(pattern, pointerBudgetSourceBytes - 1)}`;
    const body = await summarySizeBody(source, pattern);
    expect(utf8(source)).toBe(pointerBudgetSourceBytes);
    expect(utf8(canonicalJson(body.graph))).toBe(ARTIFACT_LIMITS.graphBytes);
    const saved = await harness.probe(`maximum-${name}`, { operation: "save", body });
    expect(saved).toMatchObject({ status: 200, body: { graphReads: 0, artifactWrites: 2 } });
    expect(summary.parse(saved.body).value).toMatchObject({
      source,
      description: body.graph.meta.description,
      input: body.graph.input,
      schedule: body.graph.meta.schedule,
    });
    expect(await harness.probe(`maximum-${name}`, { operation: "list" })).toMatchObject({
      status: 200,
      body: { graphReads: 0, artifactWrites: 0 },
    });

    const stored = inspect.parse(
      (await harness.probe(`maximum-${name}`, { operation: "inspect" })).body,
    ).value;

    expect(stored.pointer.sourceBytes).toBe(pointerBudgetSourceBytes);
    expect(utf8(stored.projection?.projection_json ?? "")).toBeLessThan(ARTIFACT_LIMITS.graphBytes);
  });
}

for (const [name, source] of [
  ["one-byte-over", `/${"x".repeat(pointerBudgetSourceBytes)}`],
  ["multibyte-over", `/${"🧪".repeat(600_000)}`],
] as const) {
  test(`${name} publication rejects its combined UTF8 pointer row before R2 writes`, async () => {
    const body = await summarySizeBody(source);
    const response = await harness.probe(`rejected-${name}`, { operation: "save", body });
    expect(response).toEqual({
      status: 400,
      body: {
        error:
          "Definition source metadata exceeds the cloud SQL row byte budget. Shorten its source path before saving.",
        graphReads: 0,
        artifactWrites: 0,
      },
    });
    expect(await harness.probe(`rejected-${name}`, { operation: "inspect" })).toMatchObject({
      status: 200,
      body: { value: { pointer: null, projection: null } },
    });
  });
}

test("JSON-root graph publication stores schema input within the row budget", async () => {
  const body = await summarySizeBody("/json-input.ts", "🧪");

  body.graph.input = { [`${fillBytes("🧪", 120_000)}?`]: "json" };
  body.graph.inputValidation = { root: "json", minItems: {}, unknownKeys: "passthrough" };
  body.graph.meta.description = "JSON input";
  body.revision = await revision(body.graph);

  const saved = await harness.probe("json-input", { operation: "save", body });
  expect(saved).toMatchObject({
    status: 200,
    body: { value: { input: "schema" }, artifactWrites: 2 },
  });

  const stored = inspect.parse(
    (await harness.probe("json-input", { operation: "inspect" })).body,
  ).value;

  expect(stored.projection?.projection_json).toBe(
    '{"scope":"project","description":"JSON input","input":"schema","schedule":{"cron":"* * * * *","tz":"UTC"},"mode":"sandbox"}',
  );
});
