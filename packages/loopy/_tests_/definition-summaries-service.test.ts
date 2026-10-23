import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definitionSummary, definitionSummarySchema, routes } from "../src/contract/index.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService as NativeService } from "../src/local/service.js";
import { summaryServiceFixture } from "./fixtures/summary-service.js";

const cleanups: (() => void)[] = [];

function fixture() {
  const f = summaryServiceFixture();
  cleanups.push(f.cleanup);

  return f;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

test("definition projection hides graph, bundles and secrets and displays JSON input as schema", async () => {
  const f = fixture();
  const saved = await f.save(f.a, "project");
  const summary = definitionSummary(saved);
  expect(summary.input).toBe("schema");
  expect(summary.revision).toBe(saved.revision);
  expect(summary).not.toHaveProperty("graph");
  expect(summary).not.toHaveProperty("bundles");
  expect(summary).not.toHaveProperty("secrets");
  expect(definitionSummarySchema.parse(summary)).toEqual(summary);
  expect((await f.service.listLoopies(f.a))[0]).toMatchObject({
    input: "schema",
    description: saved.description,
  });
});

test("one grouped counts read maps globals across workspaces, projects to their workspace and keeps first slug selection", async () => {
  const f = fixture();
  await f.save(f.a, "shared", "global");
  await f.save(f.a, "project");
  await f.save(f.b, "project");
  await f.save(f.b, "zero");
  await f.run("a-global", f.a, "shared", "queued");
  await f.run("b-global", f.b, "shared", "failed");
  await f.run("deleted-global", f.b, "removed", "cancelled");
  await f.run("a-project", f.a, "project", "succeeded");
  await f.run("b-project", f.b, "project", "failed");
  const views = routes.loopies.response.parse(await f.service.listLoopies(f.a));
  expect(f.store.groupedReads).toBe(1);
  expect(views.map((view) => view.slug)).toEqual(["project", "shared", "zero"]);
  expect(views.find((view) => view.slug === "shared")?.counts).toEqual({
    queued: 1,
    running: 0,
    suspended: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
  });
  expect(views.find((view) => view.slug === "project")).toMatchObject({
    workspace: f.a,
    counts: { succeeded: 1, failed: 0 },
  });
  expect(views.find((view) => view.slug === "zero")?.counts).toEqual({
    queued: 0,
    running: 0,
    suspended: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  });
  expect(f.calls.lists).toEqual(
    new Map([
      [f.a, 1],
      [f.b, 1],
    ]),
  );
  expect(f.calls.summaries.size).toBe(0);
  expect(f.calls.graphs).toEqual([]);
});

test("run metadata fetches each selected slug once per canonical workspace and caches missing definitions", async () => {
  const f = fixture();
  const saved = await f.save(f.a, "chosen");
  await f.save(f.a, "unrelated");
  await f.run("canonical", f.a, "chosen", "queued");
  await f.run("alias", "alias", "chosen", "queued");
  await f.run("missing-a", f.a, "removed", "queued");
  await f.run("missing-alias", "alias", "removed", "queued");
  const runs = await f.service.listRuns({ limit: 200 });
  expect(runs.filter((run) => run.slug === "chosen").map((run) => run.loopy.description)).toEqual([
    saved.description,
    saved.description,
  ]);
  expect(
    runs.filter((run) => run.slug === "removed").every((run) => run.loopy.description === null),
  ).toBe(true);
  expect(f.calls.summaries).toEqual(
    new Map([
      [JSON.stringify([f.a, "chosen"]), 1],
      [JSON.stringify([f.a, "removed"]), 1],
    ]),
  );
  expect(f.calls.lists.size).toBe(0);
  expect(f.calls.graphs).toEqual([]);
});

test("start and schedule use direct get, distinguishing absent definitions from storage failures", async () => {
  const f = fixture();

  for (const slug of ["missing", "corrupt"]) {
    const error =
      slug === "missing" ? { code: "not_found" } : { message: "Stored graph is corrupt." };

    await expect(f.service.startRun(slug, {}, f.a)).rejects.toMatchObject(error);
    await expect(f.service.putSchedule(slug, { cron: "* * * * *" }, f.a)).rejects.toMatchObject(
      error,
    );
  }

  expect(await f.store.listRuns()).toEqual([]);
  expect(await f.store.listSchedules()).toEqual([]);
  expect(f.calls.graphs).toEqual(["missing", "missing", "corrupt", "corrupt"]);
  expect(f.calls.lists.size).toBe(0);
});

test("native adapter distinguishes absence from corrupt existing files", async () => {
  const f = fixture();
  await f.save(f.a, "native");

  const service = new NativeService({
    store: f.store,
    registry: f.registry,
    clock: SYSTEM_CLOCK,
  });

  await expect(service.startRun("missing", {}, f.a)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.putSchedule("missing", { cron: "* * * * *" }, f.a)).rejects.toMatchObject({
    code: "not_found",
  });
  writeFileSync(join(f.a, ".loopy", "loopies", "obsolete.json"), JSON.stringify({ version: 1 }));
  await expect(service.startRun("obsolete", {}, f.a)).rejects.toMatchObject({ code: "not_found" });
  await expect(service.putSchedule("obsolete", { cron: "* * * * *" }, f.a)).rejects.toMatchObject({
    code: "not_found",
  });
  writeFileSync(join(f.a, ".loopy", "loopies", "native.json"), JSON.stringify({ version: 2 }));
  await expect(service.startRun("native", {}, f.a)).rejects.toHaveProperty("name", "ZodError");
  await expect(service.putSchedule("native", { cron: "* * * * *" }, f.a)).rejects.toHaveProperty(
    "name",
    "ZodError",
  );
  writeFileSync(join(f.a, ".loopy", "loopies", "native.json"), "{invalid");
  await expect(service.startRun("native", {}, f.a)).rejects.toBeInstanceOf(SyntaxError);
  await expect(service.putSchedule("native", { cron: "* * * * *" }, f.a)).rejects.toBeInstanceOf(
    SyntaxError,
  );
  await expect(service.graph("native", f.a)).rejects.toBeInstanceOf(SyntaxError);
  expect(await f.store.listRuns()).toEqual([]);
});
