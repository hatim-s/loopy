import { expect, test } from "bun:test";
import { MemoryRunStore } from "../src/runtime/index.js";
import { defineCommand, type Json, loopy } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import { base64Descriptor } from "../src/sdk/shell/text/format.js";
import { FakeExecutor } from "./engine-fixture.js";

const probe = defineCommand({
  key: "test.probe",
  program: "probe",
  positionalSeparator: true,
  positionals: [{ name: "source" }, { name: "targets", variadic: true }],
  flags: {
    mode: { cli: "--mode", kind: "string", choices: ["fast", "safe"], style: "equals" },
    count: { cli: "-n", kind: "number" },
    quiet: { cli: "-q", kind: "boolean" },
    include: { cli: "-I", kind: "string", repeatable: true, style: "attached" },
  },
});

async function execute(run: () => Promise<Json | void>) {
  const executor = new FakeExecutor();
  const store = new MemoryRunStore();

  const result = await startLoopy({
    store,
    executor,
    input: {},
    runId: "probe",
    bundleHash: "",
    cwd: "/workspace",
    loopy: loopy({
      name: "probe",
      run: async () => {
        await run();

        return null;
      },
    }),
  });

  return { executor, store, result };
}

test("defineCommand builds enum, numeric, repeated and positional arguments", async () => {
  const f = await execute(() =>
    probe({
      args: ["source", "one", "two"],
      flags: { mode: "safe", count: 3, quiet: false, include: ["lib", "src"] },
    }),
  );

  expect(f.result).toMatchObject({ status: "succeeded" });
  expect(f.executor.calls[0]).toMatchObject({
    program: "probe",
    args: ["--mode=safe", "-n", "3", "-Ilib", "-Isrc", "--", "source", "one", "two"],
  });
});

test("enum values are validated for JavaScript callers", async () => {
  // @ts-expect-error JavaScript can supply an unsupported enum value.
  const f = await execute(() => probe({ flags: { mode: "quick" } }));
  expect(f.result).toEqual({
    status: "failed",
    error: "Flag '--mode' must be one of: fast, safe. Choose an allowed value.",
  });
  expect(f.executor.calls).toEqual([]);
});

test("unknown flags report the allowed list", async () => {
  // @ts-expect-error JavaScript can supply unknown flags.
  const f = await execute(() => probe({ flags: { typo: true } }));
  expect(f.result).toEqual({
    status: "failed",
    error: "Unknown flag 'typo'. Use an allowed flag: mode, count, quiet, include.",
  });
});

test("runtime flag types are validated before execution", async () => {
  // @ts-expect-error JavaScript can supply the wrong flag type.
  const f = await execute(() => probe({ flags: { count: "3" } }));
  expect(f.result).toEqual({
    status: "failed",
    error: "Flag '-n' requires a number value. Supply the declared flag type.",
  });
});

test("platform variants merge at call time and preserve unchanged flags", async () => {
  let platform = "darwin";

  const stat = defineCommand(
    {
      namespace: "test",
      name: "stat",
      program: "stat",
      flags: { format: { cli: "-f", kind: "string" }, follow: { cli: "-L", kind: "boolean" } },
      variants: {
        linux: { flags: { format: { cli: "--format", kind: "string", style: "equals" } } },
      },
    },
    { platform: () => platform },
  );

  const f = await execute(async () => {
    await stat({ flags: { format: "%s", follow: true } });
    platform = "linux";
    await stat({ flags: { format: "%s", follow: true } });
  });

  expect(f.executor.calls.map(({ args }) => args)).toEqual([
    ["-f", "%s", "-L"],
    ["--format=%s", "-L"],
  ]);
  expect((await f.store.getSteps("probe")).map(({ key }) => key)).toEqual([
    "test.stat",
    "test.stat",
  ]);
});

function compileOnlyChecks() {
  // @ts-expect-error Required variadic targets need at least one value after source.
  probe({ args: ["source"] });
  // @ts-expect-error Fixed positionals must also be strings.
  probe({ args: [42, "target"] });
}

void compileOnlyChecks;

test.each([
  ["darwin", ["-D", "-i", "input"]],
  ["linux", ["-d", "input"]],
])("base64 renders typed input on %s", async (platform, expected) => {
  const base64 = defineCommand(base64Descriptor, { platform: () => platform });
  const f = await execute(() => base64({ flags: { input: "input", decode: true } }));
  expect(f.result.status).toBe("succeeded");
  expect(f.executor.calls[0]?.args).toEqual(expected);
});
