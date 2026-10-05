import { expect, test } from "bun:test";
import {
  type ModalCompilerOptions,
  ModalIsolatedCompiler,
} from "../src/providers/modal-compiler.js";
import { preparePublishBundle } from "../src/publishing/manifest.js";
import type { CompileRequest } from "../src/publishing/service.js";

const image = `registry.example/loopy@sha256:${"a".repeat(64)}`;
const workflow = {
  version: 1,
  slug: "demo",
  nodes: [{ id: "first", kind: "command", command: { program: "echo", args: ["ok"] } }],
};
async function request(signal = new AbortController().signal): Promise<CompileRequest> {
  const bundle = await preparePublishBundle(
    {
      entrypoint: "main.ts",
      files: ["main.ts", "package.json", "bun.lock"],
      sources: [],
      lockfile: "bun.lock",
      compiler: "compiler@1",
      runtime: { build: "runtime@1", graphSchema: 1 },
    },
    async () => new TextEncoder().encode("source"),
  );
  return {
    bundle,
    signal,
    policy: {
      deadlineMs: Date.now() + 60_000,
      maxOutputBytes: 100_000,
      serviceCredentials: false,
      dependencies: "locked-only",
    },
  };
}
function fake(options: { output?: string; exit?: number; terminationFailure?: boolean } = {}) {
  let creates = 0;
  let terminates = 0;
  const inputs: string[] = [];
  let settings: unknown;
  const commands: string[][] = [];
  const stream = (text: string) =>
    new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    });
  const client = {
    apps: {
      fromName: async (name: string, policy: unknown) => {
        expect(name).toBe("compiler-app");
        expect(policy).toEqual({ createIfMissing: false });
        return {};
      },
    },
    images: {
      fromRegistry: (reference: string) => {
        expect(reference).toBe(image);
        return {};
      },
    },
    sandboxes: {
      create: async (_app: unknown, _image: unknown, params: unknown) => {
        creates++;
        settings = params;
        return {
          terminate: async () => {
            terminates++;
            if (options.terminationFailure) throw new Error("SDK termination failure");
          },
          exec: async (argv: string[]) => {
            commands.push(argv);
            return {
              stdin: new WritableStream<string>({
                write(value) {
                  inputs.push(value);
                },
              }),
              stdout: stream(
                argv[0] === "cat"
                  ? (options.output ?? JSON.stringify({ workflow }))
                  : "entrypoint console.log output",
              ),
              stderr: stream(""),
              wait: async () => options.exit ?? 0,
            };
          },
        };
      },
    },
  } as unknown as ModalCompilerOptions["client"];
  return {
    compiler: new ModalIsolatedCompiler({ client, appName: "compiler-app", image }),
    snapshot: () => ({ creates, terminates, inputs, settings, commands }),
  };
}

test("Modal compiler confines author evaluation to a fresh pinned sandbox with explicit bounded policy", async () => {
  const fixture = fake();
  const input = await request();
  expect(await fixture.compiler.compile(input)).toEqual({
    workflow,
    imageDigest: `sha256:${"a".repeat(64)}`,
  });
  const called = fixture.snapshot();
  expect(called.creates).toBe(1);
  expect(called.terminates).toBe(1);
  expect(called.settings).toMatchObject({
    blockNetwork: true,
    secrets: [],
    volumes: {},
    env: {},
    cpuLimit: 1,
    memoryLimitMiB: 512,
  });
  expect(called.commands).toEqual([
    ["bun", "/opt/loopy/dist/providers/compiler-worker.js"],
    ["cat", "/compile-result.json"],
  ]);
  expect(JSON.parse(called.inputs[0] ?? "").sha256).toBe(input.bundle.sha256);
});

test("compiler failures and output bounds terminate the sandbox and never return a graph", async () => {
  for (const options of [{ exit: 1 }, { output: "x".repeat(100_001) }, { output: "not JSON" }]) {
    const fixture = fake(options);
    await expect(fixture.compiler.compile(await request())).rejects.toThrow();
    expect(fixture.snapshot().terminates).toBe(1);
  }
});

test("aborted compilation and unsupported policies create no remote resources", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = fake();
  await expect(fixture.compiler.compile(await request(controller.signal))).rejects.toThrow();
  const expired = await request();
  await expect(
    fixture.compiler.compile({
      ...expired,
      policy: { ...expired.policy, deadlineMs: Date.now() - 1 },
    }),
  ).rejects.toThrow("deadline");
  expect(fixture.snapshot().creates).toBe(0);
});

test("unconfirmed sandbox termination prevents returning a successful compilation", async () => {
  const fixture = fake({ terminationFailure: true });
  await expect(fixture.compiler.compile(await request())).rejects.toThrow(
    "termination could not be confirmed",
  );
  expect(fixture.snapshot().terminates).toBe(1);
});
