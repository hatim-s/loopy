import { expect, test } from "bun:test";
import { isRecord } from "../src/core/index.js";
import { activate, type Clock, MemoryRunStore, NESTED_STEP_MESSAGE } from "../src/runtime/index.js";
import { WRAP } from "../src/sdk/current.js";
import {
  command,
  log,
  loopy,
  now,
  random,
  type StandardSchemaV1,
  sleep,
  step,
  uuid,
} from "../src/sdk/index.js";
import { runLoopy } from "../src/sdk/run.js";
import { FakeExecutor } from "./engine-fixture.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const NAME_SCHEMA: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    // BOUNDARY: This hand-written schema receives external run input.
    async validate(value: unknown) {
      if (!isRecord(value) || typeof value.name !== "string") {
        return { issues: [{ message: "Supply a name", path: [{ key: "name" }] }] };
      }

      return { value: { name: value.name.trim() } };
    },
  },
};

function fixture() {
  let time = Date.parse("2026-10-16T00:00:00.000Z");
  const clock: Clock = { now: () => time, timeout: () => () => {} };

  return {
    store: new MemoryRunStore(),
    executor: new FakeExecutor(),
    runId: "sdk-run",
    cwd: "/workspace",
    clock,
    advance(milliseconds: number) {
      time += milliseconds;
    },
  };
}

test("a Standard Schema validates input and infers the workflow input type", async () => {
  const f = fixture();

  const definition = loopy({
    name: "schema",
    input: NAME_SCHEMA,
    run: async ({ input }) => {
      const inferred = true satisfies Equal<typeof input, { name: string }>;

      return { name: input.name, inferred };
    },
  });

  expect(await runLoopy({ ...f, loopy: definition, input: { name: " Hatim " } })).toEqual({
    status: "succeeded",
    output: { name: "Hatim", inferred: true },
  });
  expect(await f.store.getRun(f.runId)).toMatchObject({
    slug: "schema",
    bundleHash: "",
    input: { name: "Hatim" },
  });
});

test("a plain record infers required and optional primitive input types", async () => {
  const definition = loopy({
    name: "record",
    input: { name: "string", count: "number", enabled: "boolean", "limit?": "number" },
    run: async ({ input }) => {
      const name = input.name satisfies string;
      const count = input.count satisfies number;
      const enabled = input.enabled satisfies boolean;
      const limit = input.limit satisfies number | undefined;
      const optional = { name, count, enabled } satisfies typeof input;

      return { ...optional, limit: limit ?? 0 };
    },
  });

  expect(
    await runLoopy({
      ...fixture(),
      loopy: definition,
      input: { name: "test", count: 2, enabled: true },
    }),
  ).toMatchObject({
    status: "succeeded",
    output: { name: "test", count: 2, enabled: true, limit: 0 },
  });
});

test("missing required fields list every issue and its path", async () => {
  const definition = loopy({
    name: "missing",
    input: { name: "string", count: "number" },
    run: async () => null,
  });

  await expect(definition.validateInput({})).rejects.toThrow(
    "Input validation failed: name: Expected string; count: Expected number. Correct the input and try again.",
  );
});

test("a plain record rejects a field with the wrong type", async () => {
  const definition = loopy({ name: "wrong", input: { count: "number" }, run: async () => null });
  await expect(definition.validateInput({ count: "2" })).rejects.toThrow("count: Expected number");
});

test("a plain record accepts an optional field when present", async () => {
  const definition = loopy({
    name: "optional",
    input: { "limit?": "number" },
    run: async ({ input }) => input.limit ?? 0,
  });

  expect(await runLoopy({ ...fixture(), loopy: definition, input: { limit: 3 } })).toEqual({
    status: "succeeded",
    output: 3,
  });
});

test("a Standard Schema failure leaves no run record", async () => {
  const f = fixture();
  const definition = loopy({ name: "invalid", input: NAME_SCHEMA, run: async () => null });
  await expect(runLoopy({ ...f, loopy: definition, input: {} })).rejects.toThrow(
    "name: Supply a name",
  );
  expect(await f.store.getRun(f.runId)).toBeUndefined();
});

test("ambient step records its result", async () => {
  const f = fixture();
  const definition = loopy({ name: "step", run: async () => step("answer", () => 42) });
  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "succeeded",
    output: 42,
  });
  expect(await f.store.getSteps(f.runId)).toMatchObject([
    { key: "answer", kind: "function", status: "succeeded", output: 42 },
  ]);
});

test("ambient sleep suspends and resumes across two activations", async () => {
  const f = fixture();
  let calls = 0;

  const definition = loopy({
    name: "sleep",
    run: async () => {
      const result = await step("before", () => ++calls);
      await sleep("1s");

      return result;
    },
  });

  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T00:00:01.000Z",
  });
  f.advance(1000);
  expect(
    await activate({
      ...f,
      mode: definition.mode,
      wrap: WRAP,
      workflow: (context) => definition.run({ ...context, input: {} }),
    }),
  ).toEqual({ status: "succeeded", output: 1 });
  expect(calls).toBe(1);
  expect((await f.store.getSteps(f.runId))[1]).toMatchObject({
    key: "sleep",
    kind: "sleep",
    status: "succeeded",
  });
});

test("ambient logs carry workflow and step attempt positions", async () => {
  const f = fixture();

  const definition = loopy({
    name: "logs",
    run: async () => {
      log.info("workflow", { count: 1 });
      await step("work", async () => {
        await Promise.resolve();
        log.warn("attempt");

        return null;
      });
      log.error("finished");

      return null;
    },
  });

  await runLoopy({ ...f, loopy: definition, input: {} });
  expect(await f.store.getLogs(f.runId)).toMatchObject([
    { level: "info", message: "workflow", data: { count: 1 }, position: { kind: "workflow" } },
    { level: "warn", message: "attempt", position: { kind: "step", seq: 1, attempt: 1 } },
    { level: "error", message: "finished", position: { kind: "workflow" } },
  ]);
});

test("ambient now records the supplied clock", async () => {
  const f = fixture();
  const definition = loopy({ name: "clock", run: async () => now() });
  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "succeeded",
    output: f.clock.now(),
  });
  expect(await f.store.getSteps(f.runId)).toMatchObject([
    { key: "now", kind: "clock", output: f.clock.now() },
  ]);
});

test("ambient random records its result", async () => {
  const f = fixture();
  const definition = loopy({ name: "random", run: async () => random() });
  const result = await runLoopy({ ...f, loopy: definition, input: {} });

  expect(result).toMatchObject({ status: "succeeded", output: expect.any(Number) });
  expect(await f.store.getSteps(f.runId)).toMatchObject([
    { key: "random", kind: "random", status: "succeeded" },
  ]);
});

test("ambient uuid records its result", async () => {
  const f = fixture();
  const definition = loopy({ name: "uuid", run: async () => uuid() });
  const result = await runLoopy({ ...f, loopy: definition, input: {} });

  expect(result).toMatchObject({ status: "succeeded", output: expect.any(String) });
  expect(await f.store.getSteps(f.runId)).toMatchObject([
    { key: "uuid", kind: "random", status: "succeeded" },
  ]);
});

test("ambient command uses the supplied executor", async () => {
  const f = fixture();

  const definition = loopy({
    name: "command",
    run: async () => command("echo", { program: "echo", args: ["ok"] }),
  });

  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "succeeded",
    output: f.executor.result,
  });
  expect(f.executor.calls).toEqual([{ program: "echo", args: ["ok"] }]);
});

test("a synchronous nested step fails the run", async () => {
  const f = fixture();

  const definition = loopy({
    name: "nested-sync",
    run: async () => step("outer", () => step("inner", () => null)),
  });

  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "failed",
    error: NESTED_STEP_MESSAGE,
  });
});

test("a nested step after await fails the run even if caught", async () => {
  const f = fixture();

  const definition = loopy({
    name: "nested-async",
    run: async () =>
      step("outer", async () => {
        await Promise.resolve();

        try {
          await step("inner", () => null);
        } catch {
          return "caught";
        }

        return null;
      }),
  });

  expect(await runLoopy({ ...f, loopy: definition, input: {} })).toEqual({
    status: "failed",
    error: NESTED_STEP_MESSAGE,
  });
  expect(await f.store.getRun(f.runId)).toMatchObject({
    status: "failed",
    error: NESTED_STEP_MESSAGE,
  });
});

test("step outside a run throws an actionable error", () => {
  expect(() => step("outside", () => null)).toThrow(
    "No loopy run is active. Call step() from inside a loopy's run function.",
  );
});

test("loopy rejects an invalid name", () => {
  expect(() => loopy({ name: "Bad name", run: async () => null })).toThrow(
    "A slug must contain 1-80 lowercase letters, numbers, or hyphens.",
  );
});

test("loopy rejects an invalid mode", () => {
  // @ts-expect-error Invalid JavaScript definitions must also fail at runtime.
  expect(() => loopy({ name: "mode", mode: "unsafe", run: async () => null })).toThrow(
    "Loopy mode must be one of sandbox, full.",
  );
});

test("loopy rejects an invalid scope", () => {
  // @ts-expect-error Invalid JavaScript definitions must also fail at runtime.
  expect(() => loopy({ name: "scope", scope: "remote", run: async () => null })).toThrow(
    "Loopy scope must be one of project, global.",
  );
});

test("loopy freezes the normalized definition", () => {
  const definition = loopy({
    name: "defaults",
    schedule: { cron: "check at save time" },
    secrets: ["TOKEN"],
    run: async () => null,
  });

  expect(definition).toMatchObject({
    mode: "sandbox",
    scope: "project",
    schedule: { cron: "check at save time" },
    secrets: ["TOKEN"],
  });
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.secrets)).toBe(true);
  expect(Object.isFrozen(definition.schedule)).toBe(true);
});

test("an omitted input schema accepts a run without input", async () => {
  const definition = loopy({ name: "no-input", run: async ({ input }) => input });

  expect(await runLoopy({ ...fixture(), loopy: definition, input: undefined })).toEqual({
    status: "succeeded",
    output: {},
  });
});

test("concurrent runs keep their ambient scopes separate", async () => {
  const f = fixture();

  const definition = loopy({
    name: "concurrent",
    input: { value: "string" },
    run: async ({ input }) => {
      const value = await step("value", async () => {
        await Promise.resolve();
        log.info(input.value);

        return input.value;
      });

      log.info(value);

      return value;
    },
  });

  const outcomes = await Promise.all(
    ["first", "second"].map((value) =>
      runLoopy({
        ...f,
        loopy: definition,
        runId: value,
        input: { value },
      }),
    ),
  );

  expect(outcomes).toEqual([
    { status: "succeeded", output: "first" },
    { status: "succeeded", output: "second" },
  ]);
  expect((await f.store.getLogs("first")).map((entry) => entry.message)).toEqual([
    "first",
    "first",
  ]);
  expect((await f.store.getLogs("second")).map((entry) => entry.message)).toEqual([
    "second",
    "second",
  ]);
});

test("loopy rejects a schedule without a cron string", () => {
  // @ts-expect-error JavaScript callers may pass malformed schedules.
  expect(() => loopy({ name: "schedule", schedule: { cron: 42 }, run: async () => null })).toThrow(
    "Schedule cron must be a string.",
  );
});

test("loopy rejects secrets that are not strings", () => {
  // @ts-expect-error JavaScript callers may pass malformed secret names.
  expect(() => loopy({ name: "secrets", secrets: [42], run: async () => null })).toThrow(
    "Secrets must be a list of strings. Supply the secret names to expose.",
  );
});

test("loopy rejects an input schema that is not an object", () => {
  // @ts-expect-error JavaScript callers may pass a malformed input schema.
  expect(() => loopy({ name: "invalid-schema", input: 42, run: async () => null })).toThrow(
    "Input schema must be an object.",
  );
});
