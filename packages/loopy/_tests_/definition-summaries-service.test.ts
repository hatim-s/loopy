import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeBoundary,
  definitionSummary,
  definitionSummarySchema,
  routes,
} from "@loopy/contract";
import { Effect } from "effect";
import { makeLocalService } from "../../runtime/src/local/service";

import { summaryServiceFixture } from "./fixtures/summary-service";

const cleanups: (() => void | Promise<void>)[] = [];

async function fixture() {
  const f = await summaryServiceFixture();
  cleanups.push(f.cleanup);

  return f;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

test("definition projection hides graph, bundles and secrets and displays JSON input as schema", async () => {
  const f = await fixture();
  const saved = await f.save(f.a, "project");
  const summary = definitionSummary(saved);
  expect(summary.input).toBe("schema");
  expect(summary.revision).toBe(saved.revision);
  expect(summary).not.toHaveProperty("graph");
  expect(summary).not.toHaveProperty("bundles");
  expect(summary).not.toHaveProperty("secrets");
  expect(decodeBoundary(definitionSummarySchema)(summary)).toEqual(summary);
  expect((await Effect.runPromise(f.service.listLoopies(f.a)))[0]).toMatchObject({
    input: "schema",
    description: saved.graph.meta.description,
  });
});

test("one grouped counts read maps globals across workspaces, projects to their workspace and keeps first slug selection", async () => {
  const f = await fixture();
  await f.save(f.a, "shared", "global");
  await f.save(f.a, "project");
  await f.save(f.b, "project");
  await f.save(f.b, "zero");
  await f.run("a-global", f.a, "shared", "queued");
  await f.run("b-global", f.b, "shared", "failed");
  await f.run("deleted-global", f.b, "removed", "cancelled");
  await f.run("a-project", f.a, "project", "succeeded");
  await f.run("b-project", f.b, "project", "failed");

  const views = decodeBoundary(routes.loopies.response)(
    await Effect.runPromise(f.service.listLoopies(f.a)),
  );

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
  const f = await fixture();
  const saved = await f.save(f.a, "chosen");
  await f.save(f.a, "unrelated");
  await f.run("canonical", f.a, "chosen", "queued");
  await f.run("alias", "alias", "chosen", "queued");
  await f.run("missing-a", f.a, "removed", "queued");
  await f.run("missing-alias", "alias", "removed", "queued");
  const runs = await Effect.runPromise(f.service.listRuns({ limit: 200 }));
  expect(runs.filter((run) => run.slug === "chosen").map((run) => run.loopy.description)).toEqual([
    saved.graph.meta.description,
    saved.graph.meta.description,
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
  const f = await fixture();

  for (const slug of ["missing", "corrupt"]) {
    const error = slug === "missing" ? { code: "not_found" } : { _tag: "RegistryError" };
    await expect(Effect.runPromise(f.service.startRun(slug, {}, f.a))).rejects.toMatchObject(error);
    await expect(
      Effect.runPromise(f.service.putSchedule(slug, { cron: "* * * * *" }, f.a)),
    ).rejects.toMatchObject(error);
  }

  expect(await Effect.runPromise(f.store.listRuns())).toEqual([]);
  expect(await Effect.runPromise(f.store.listSchedules())).toEqual([]);
  expect(f.calls.graphs).toEqual(["missing", "missing", "corrupt", "corrupt"]);
  expect(f.calls.lists.size).toBe(0);
});

test("native adapter distinguishes absence from corrupt existing files", async () => {
  const f = await fixture();
  await f.save(f.a, "native");

  const service = makeLocalService({
    store: f.store,
    clock: { now: Date.now },
    home: f.home,
    cwd: f.a,
  });

  await expect(Effect.runPromise(service.startRun("missing", {}, f.a))).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    Effect.runPromise(service.putSchedule("missing", { cron: "* * * * *" }, f.a)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  writeFileSync(join(f.a, ".loopy", "loopies", "obsolete.json"), JSON.stringify({ version: 1 }));
  await expect(Effect.runPromise(service.startRun("obsolete", {}, f.a))).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    Effect.runPromise(service.putSchedule("obsolete", { cron: "* * * * *" }, f.a)),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  writeFileSync(join(f.a, ".loopy", "loopies", "native.json"), JSON.stringify({ version: 3 }));
  await expect(Effect.runPromise(service.startRun("native", {}, f.a))).rejects.toHaveProperty(
    "_tag",
    "RegistryError",
  );
  await expect(
    Effect.runPromise(service.putSchedule("native", { cron: "* * * * *" }, f.a)),
  ).rejects.toHaveProperty("_tag", "RegistryError");
  writeFileSync(join(f.a, ".loopy", "loopies", "native.json"), "{invalid");
  await expect(Effect.runPromise(service.startRun("native", {}, f.a))).rejects.toHaveProperty(
    "_tag",
    "RegistryError",
  );
  await expect(
    Effect.runPromise(service.putSchedule("native", { cron: "* * * * *" }, f.a)),
  ).rejects.toHaveProperty("_tag", "RegistryError");
  await expect(Effect.runPromise(service.graph("native", f.a))).rejects.toHaveProperty(
    "_tag",
    "RegistryError",
  );
  expect(await Effect.runPromise(f.store.listRuns())).toEqual([]);
});
