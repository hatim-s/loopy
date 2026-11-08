import { expect, test } from "bun:test";
import { SCHEDULE_POLICY } from "@loopy/runtime/host";
import { Cause, Effect } from "effect";
import { SCHEDULER } from "../src/scheduler";
import { base, fixture, graph, work } from "./fixtures/scheduler";

test("invalid input, absent definitions and registry failures isolate schedules and recover", async () => {
  const f = fixture();
  await f.run("running", graph("running"));
  await Effect.runPromise(f.scheduler().tick());
  f.provider.finishAll();
  const failedAt = 500;
  f.at(failedAt);
  await f.run("queued", graph("queued"));
  await f.schedule(graph("invalid"));
  const changed = graph("invalid");
  changed.input = { required: "string" };
  await f.registry.save(changed);
  await f.schedule(graph("transient"));
  f.registry.failures.add("transient");
  await f.schedule(graph("missing"));
  f.registry.current.delete("missing");
  await f.schedule(graph("healthy"));
  await Effect.runPromise(f.scheduler().tick());
  expect((await Effect.runPromise(f.store.getRun("running")))?.status).toBe("succeeded");
  expect((await Effect.runPromise(f.store.getRun("queued")))?.status).toBe("running");
  expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
  expect(
    (await Effect.runPromise(f.store.listSchedules())).find((s) => s.slug === "invalid")?.enabled,
  ).toBe(false);
  const failures = new Map((await f.scheduleFailures()).map((failure) => [failure.slug, failure]));

  expect(failures.get("invalid")).toMatchObject({
    retryAt: null,
    error:
      "Schedule disabled because the saved input no longer matches the current graph: Input does not match the saved graph schema.",
  });

  const retry = failures.get("transient");
  const retryAt = failedAt + SCHEDULE_POLICY.retryMs;
  expect(retry?.retryAt).toBe(new Date(base + retryAt).toISOString());
  expect(retry?.error).toStartWith("Could not get. Registry unavailable.");
  expect(retry?.error.length).toBe(SCHEDULE_POLICY.errorChars);
  expect(await f.runs("missing")).toEqual([]);
  expect(
    (await Effect.runPromise(f.store.listSchedules())).find((s) => s.slug === "missing")?.enabled,
  ).toBe(true);
  expect(failures.get("missing")).toMatchObject({
    retryAt: new Date(base + retryAt).toISOString(),
    error: "No saved loopy 'missing'. Use loopy save <file.ts> first.",
  });
  expect(f.schedulerError()).toBeNull();
  f.at(1000);
  f.provider.finishAll();
  await Effect.runPromise(f.scheduler("original").tick());
  expect(f.registry.reads.get("transient")).toBe(1);
  expect(f.registry.reads.get("missing")).toBe(1);
  expect(f.storage.alarm).toBe(base + retryAt);
  f.registry.failures.clear();
  const restored = graph("missing", () => work("restored"));
  const restoredRevision = await f.registry.save(restored);
  f.at(retryAt);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("transient")).toHaveLength(1);
  expect(await f.runs("healthy")).toHaveLength(1);
  expect((await f.scheduleFailures()).map((failure) => failure.slug)).toEqual(["invalid"]);
  expect((await f.runs("transient"))[0]?.status).toBe("running");
  expect(await f.runs("missing")).toMatchObject([
    { status: "running", revision: restoredRevision },
  ]);
  await f.registry.save(graph("missing", () => work("later")));
  expect((await f.runs("missing"))[0]?.revision).toBe(restoredRevision);
});

for (const failure of ["before", "after"] as const) {
  test(`schedule fire failure ${failure} commit is bounded and does not duplicate a fire`, async () => {
    const f = fixture();
    await f.schedule(graph("broken"));
    await f.schedule(graph("healthy"));
    f.store.fireFailures.set("broken", failure);
    await Effect.runPromise(f.scheduler().tick());
    expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
    expect(await f.runs("broken")).toHaveLength(failure === "before" ? 0 : 1);
    expect(await f.scheduleFailures()).toMatchObject([
      {
        slug: "broken",
        error:
          failure === "before"
            ? "Storage operation 'fire' failed: Schedule transaction unavailable."
            : "Storage operation 'fire' failed: Schedule commit response lost.",
      },
    ]);
    f.provider.finishAll();
    f.at(500);
    await Effect.runPromise(f.scheduler().tick());
    expect(f.registry.reads.get("broken")).toBe(1);
    // A failed fire retries after the policy delay; a committed one waits for the next minute.
    expect(f.storage.alarm).toBe(base + (failure === "before" ? SCHEDULE_POLICY.retryMs : 60_000));
    f.at(SCHEDULE_POLICY.retryMs);
    await Effect.runPromise(f.scheduler().tick());
    expect(await f.runs("broken")).toHaveLength(1);
    expect(await f.runs("healthy")).toHaveLength(1);
  });
}

test("a full failing schedule batch yields to later schedules on the next alarm", async () => {
  const f = fixture();

  for (let index = 0; index < SCHEDULE_POLICY.batch; index++) {
    const slug = `broken-${String(index).padStart(2, "0")}`;
    await f.schedule(graph(slug));
    f.registry.failures.add(slug);
  }

  await f.schedule(graph("healthy"));
  await f.run("queued", graph("queued"));
  await Effect.runPromise(f.scheduler().tick());
  expect((await Effect.runPromise(f.store.getRun("queued")))?.status).toBe("running");
  expect(await f.runs("healthy")).toEqual([]);
  expect(f.storage.alarm).toBe(base + SCHEDULER.alarmFloorMs);
  f.at(SCHEDULER.alarmFloorMs);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
  expect(f.registry.reads.get("broken-00")).toBe(1);
  // The queued run polls on the interval counted from its first turn.
  expect(f.storage.alarm).toBe(base + SCHEDULER.pollMs);
});

test("scheduler isolates provider and schedule defects and retains recovery alarms", async () => {
  const f = fixture();
  const broken = graph("broken");
  const healthy = graph("healthy");
  await f.run("broken", broken);
  await f.run("healthy", healthy);
  const lookup = f.provider.lookup.bind(f.provider);
  f.provider.lookup = (key, attempt) =>
    key.runId === "broken" ? Effect.die(new Error("provider defect")) : lookup(key, attempt);
  await Effect.runPromise(f.scheduler().tick());
  expect(await Effect.runPromise(f.store.getRun("healthy"))).toMatchObject({ status: "running" });
  expect(await f.turnErrors()).toEqual([{ runId: "broken", error: "provider defect" }]);
  await f.schedule(graph("broken-schedule"));
  await f.schedule(graph("healthy-schedule"));
  const get = f.registry.get.bind(f.registry);
  f.registry.get = (slug) =>
    slug === "broken-schedule" ? Effect.die(new Error("schedule defect")) : get(slug);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("healthy-schedule")).toHaveLength(1);
  expect(await f.scheduleFailures()).toMatchObject([
    { slug: "broken-schedule", error: "schedule defect" },
  ]);
  f.store.pruneEvents = () => Effect.die(new Error("prune defect"));
  await Effect.runPromise(f.scheduler().tick());
  expect(f.schedulerError()).toBe("prune defect");
  expect(f.storage.alarm).toBe(base + SCHEDULER.recoveryMs);
});

test("scheduler interruption preserves the recovery alarm without recording a failure", async () => {
  const f = fixture();
  await f.run("interrupted", graph("interrupted"));
  f.provider.lookup = () => Effect.interrupt;
  const exit = await Effect.runPromiseExit(f.scheduler().tick());
  expect(exit._tag).toBe("Failure");

  if (exit._tag === "Failure") {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  }

  expect(f.storage.alarm).toBe(base + SCHEDULER.recoveryMs);
  expect(f.schedulerError()).toBeNull();
});
