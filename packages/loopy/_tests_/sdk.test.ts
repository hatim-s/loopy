import { expect, test } from "bun:test";
import { isRecord } from "../src/core/index.js";
import { type Clock, MemoryRunStore } from "../src/runtime/index.js";
import { NESTED_STEP_MESSAGE } from "../src/sdk/current.js";
import {
  command,
  type Loopy,
  type LoopyContext,
  log,
  loopy,
  now,
  random,
  type StandardSchemaV1,
  sleep,
  step,
  uuid,
} from "../src/sdk/index.js";
import { activateLoopy } from "../src/sdk/run.js";
import { FakeExecutor, startLoopy } from "./fixture.js";

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
    bundleHash: "",
    workspace: "/workspace",
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
      const inferred: Equal<typeof input, { name: string }> = true;

      return { name: input.name, inferred };
    },
  });

  expect(await startLoopy({ ...f, loopy: definition, input: { name: " Hatim " } })).toEqual({
    status: "succeeded",
    output: { name: "Hatim", inferred: true },
  });
  expect(await f.store.getRun(f.runId)).toMatchObject({
    slug: "schema",
    revision: "",
    input: { name: "Hatim" },
  });
});

test("a plain record infers required and optional primitive input types", async () => {
  const definition = loopy({
    name: "record",
    input: { name: "string", count: "number", enabled: "boolean", "limit?": "number" },
    run: async ({ input }) => {
      const inferred: Equal<
        typeof input,
        { name: string; count: number; enabled: boolean; limit?: number }
      > = true;

      expect(inferred).toBe(true);

      return { ...input, limit: input.limit ?? 0 };
    },
  });

  expect(
    await startLoopy({
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

  expect(await startLoopy({ ...fixture(), loopy: definition, input: { limit: 3 } })).toEqual({
    status: "succeeded",
    output: 3,
  });
});

test("a Standard Schema failure leaves no run record", async () => {
  const f = fixture();
  const definition = loopy({ name: "invalid", input: NAME_SCHEMA, run: async () => null });
  await expect(startLoopy({ ...f, loopy: definition, input: {} })).rejects.toThrow(
    "name: Supply a name",
  );
  expect(await f.store.getRun(f.runId)).toBeUndefined();
});

test("ambient step records its result", async () => {
  const f = fixture();
  const definition = loopy({ name: "step", run: async () => step("answer", () => 42) });
  expect(await startLoopy({ ...f, loopy: definition, input: {} })).toEqual({
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
    input: { value: "number" },
    run: async ({ input }) => {
      const result = await step("before", () => ++calls);
      await sleep("1s");

      return result + input.value;
    },
  });

  expect(await startLoopy({ ...f, loopy: definition, input: { value: 4 } })).toEqual({
    status: "suspended",
    wakeAt: "2026-10-16T00:00:01.000Z",
  });
  f.advance(1000);
  expect(await activateLoopy({ ...f, loopy: definition })).toEqual({
    status: "succeeded",
    output: 5,
  });
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

  await startLoopy({ ...f, loopy: definition, input: {} });
  expect(await f.store.getLogs(f.runId)).toMatchObject([
    { level: "info", message: "workflow", data: { count: 1 }, position: { kind: "workflow" } },
    { level: "warn", message: "attempt", position: { kind: "step", seq: 1, attempt: 1 } },
    { level: "error", message: "finished", position: { kind: "workflow" } },
  ]);
});

test("ambient now records the supplied clock", async () => {
  const f = fixture();
  const definition = loopy({ name: "clock", run: async () => now() });
  expect(await startLoopy({ ...f, loopy: definition, input: {} })).toEqual({
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
  const result = await startLoopy({ ...f, loopy: definition, input: {} });

  expect(result).toMatchObject({ status: "succeeded", output: expect.any(Number) });
  expect(await f.store.getSteps(f.runId)).toMatchObject([
    { key: "random", kind: "random", status: "succeeded" },
  ]);
});

test("ambient uuid records its result", async () => {
  const f = fixture();
  const definition = loopy({ name: "uuid", run: async () => uuid() });
  const result = await startLoopy({ ...f, loopy: definition, input: {} });

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

  expect(await startLoopy({ ...f, loopy: definition, input: {} })).toEqual({
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

  expect(await startLoopy({ ...f, loopy: definition, input: {} })).toEqual({
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

  expect(await startLoopy({ ...f, loopy: definition, input: {} })).toEqual({
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
    schedule: { cron: "0 * * * *" },
    secrets: ["TOKEN"],
    run: async () => null,
  });

  expect(definition).toMatchObject({
    mode: "sandbox",
    scope: "project",
    schedule: { cron: "0 * * * *" },
    secrets: ["TOKEN"],
  });
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.secrets)).toBe(true);
  expect(Object.isFrozen(definition.schedule)).toBe(true);
});

test("an omitted input schema accepts a run without input", async () => {
  const definition = loopy({ name: "no-input", run: async ({ input }) => input });

  expect(await startLoopy({ ...fixture(), loopy: definition, input: undefined })).toEqual({
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
      startLoopy({
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

test("a run context's now cannot bypass the nested step check", async () => {
  const definition = loopy({
    name: "nested-context",
    run: ({ now }) => step("outer", () => now()),
  });

  expect(await startLoopy({ ...fixture(), loopy: definition, input: {} })).toEqual({
    status: "failed",
    error: NESTED_STEP_MESSAGE,
  });
});

test("the run context exposes only author functions and logs at the active step", async () => {
  const f = fixture();

  const definition = loopy({
    name: "context",
    run: async (context) => {
      const inferred: Equal<typeof context, LoopyContext<Record<string, never>>> = true;
      expect(inferred).toBe(true);
      expect(Object.keys(context).sort()).toEqual(["input", "log", "now", "random", "uuid"]);
      await step("work", async () => {
        await Promise.resolve();
        context.log.info("inside");

        return null;
      });

      return null;
    },
  });

  await startLoopy({ ...f, loopy: definition, input: {} });
  expect(await f.store.getLogs(f.runId)).toMatchObject([
    { message: "inside", position: { kind: "step", seq: 1, attempt: 1 } },
  ]);
});

test("a typed loopy is assignable to plain Loopy and accepts a synchronous run", async () => {
  const typed: Loopy<{ a: string }, string> = loopy({
    name: "typed",
    input: { a: "string" },
    run: ({ input }) => input.a,
  });

  const definition: Loopy = typed;

  expect(await startLoopy({ ...fixture(), loopy: definition, input: { a: "ok" } })).toEqual({
    status: "succeeded",
    output: "ok",
  });
});

test("record input reports every unknown field", async () => {
  const definition = loopy({ name: "unknown-input", input: { a: "string" }, run: () => null });

  await expect(definition.validateInput({ a: "ok", typo: 1, extra: false })).rejects.toThrow(
    "Input validation failed: typo: Unknown field; extra: Unknown field. Correct the input and try again.",
  );
});

test("loopy rejects a missing run function", () => {
  // @ts-expect-error JavaScript callers may omit the run function.
  expect(() => loopy({ name: "missing-run" })).toThrow(
    "Loopy run must be a function. Supply a run(context) function.",
  );
});

test("loopy rejects a non-function run", () => {
  // @ts-expect-error JavaScript callers may supply a malformed run function.
  expect(() => loopy({ name: "invalid-run", run: 42 })).toThrow(
    "Loopy run must be a function. Supply a run(context) function.",
  );
});

test("loopy rejects unknown definition fields", () => {
  // @ts-expect-error JavaScript callers may misspell definition fields.
  expect(() => loopy({ name: "unknown-key", typo: true, run: () => null })).toThrow(
    "Loopy definition has an unsupported field 'typo'.",
  );
});

test("loopy validates cron expressions when defined", () => {
  expect(() =>
    loopy({ name: "cron", schedule: { cron: "check at save time" }, run: () => null }),
  ).toThrow(
    "Provide five fields: minute hour day-of-month month day-of-week, or a supported alias.",
  );
});

test("loopy validates schedule timezones when defined", () => {
  expect(() =>
    loopy({ name: "tz", schedule: { cron: "@daily", tz: "invalid/zone" }, run: () => null }),
  ).toThrow(
    "Invalid schedule timezone 'invalid/zone'. Provide an IANA time zone such as 'Asia/Kolkata'.",
  );
  expect(
    loopy({ name: "tz", schedule: { cron: "@daily", tz: "Asia/Kolkata" }, run: () => null })
      .schedule,
  ).toEqual({ cron: "@daily", tz: "Asia/Kolkata" });
});

function compileOnlyChecks() {
  loopy({
    name: "wrong-record-field",
    input: { a: "string" },
    run: ({ input }) => {
      // @ts-expect-error Record input fields keep their declared primitive types.
      const wrong: typeof input = { a: 42 };
      // @ts-expect-error Record input exposes only the declared fields.
      const typo: string = input.typo;

      return wrong.a + typo;
    },
  });
}

void compileOnlyChecks;

test("record json fields preserve nested JSON and reject host values", async () => {
  const definition = loopy({
    name: "json-input",
    input: { data: "json" },
    run: ({ input }) => input.data,
  });

  const data = { nested: [null, true, 2, "value"] };
  expect(await startLoopy({ ...fixture(), loopy: definition, input: { data } })).toEqual({
    status: "succeeded",
    output: data,
  });
  await expect(
    startLoopy({ ...fixture(), loopy: definition, input: { data: () => "host" } }),
  ).rejects.toThrow("Expected json");
});
