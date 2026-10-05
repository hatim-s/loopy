import { expect, test } from "bun:test";
import { SandboxService } from "modal";
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
function fake(
  options: {
    output?: string;
    exit?: number;
    terminationFailure?: boolean;
    termination?: () => Promise<number>;
  } = {},
) {
  let creates = 0;
  let terminates = 0;
  const inputs: string[] = [];
  let settings: unknown;
  const commands: string[][] = [];
  const terminations: unknown[] = [];
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
          terminate: async (params: unknown) => {
            terminations.push(params);
            terminates++;
            if (options.terminationFailure) throw new Error("SDK termination failure");
            return options.termination ? await options.termination() : 137;
          },
          exec: async (argv: string[], params: { timeoutMs: number }) => {
            expect(params.timeoutMs % 1_000).toBe(0);
            expect(params.timeoutMs).toBeGreaterThanOrEqual(1_000);
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
    snapshot: () => ({ creates, terminates, inputs, settings, commands, terminations }),
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
  expect(called.terminations).toEqual([{ wait: true }]);
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

test("installed Modal SDK accepts quantized sandbox timeout without any provider calls", async () => {
  let boundaryReached = false;
  let timeoutSeconds = 0;
  const sdk = new SandboxService({
    profile: { sandboxV2: false },
    cpClient: {
      sandboxCreate: async (request: { definition: { timeoutSecs: number } }) => {
        boundaryReached = true;
        timeoutSeconds = request.definition.timeoutSecs;
        throw new Error("offline SDK boundary");
      },
    },
  } as unknown as ConstructorParameters<typeof SandboxService>[0]);
  const app = { appId: "ap-offline" } as Parameters<typeof sdk.create>[0];
  const registryImage = { imageId: "im-offline", build: async () => {} } as unknown as Parameters<
    typeof sdk.create
  >[1];
  await expect(sdk.create(app, registryImage, { timeoutMs: 59_999 })).rejects.toThrow(
    "multiple of 1000",
  );
  expect(boundaryReached).toBe(false);
  const client = {
    apps: { fromName: async () => app },
    images: { fromRegistry: () => registryImage },
    sandboxes: sdk,
  } as unknown as ModalCompilerOptions["client"];
  const compiler = new ModalIsolatedCompiler({ client, appName: "offline", image });
  const input = await request();
  await expect(
    compiler.compile({ ...input, policy: { ...input.policy, deadlineMs: Date.now() + 59_999 } }),
  ).rejects.toThrow("offline SDK boundary");
  expect(boundaryReached).toBe(true);
  expect(timeoutSeconds).toBe(59);
});

test("stalled Modal app lookup obeys the absolute host deadline before allocation", async () => {
  let creates = 0;
  const client = {
    apps: { fromName: () => new Promise(() => {}) },
    images: { fromRegistry: () => ({}) },
    sandboxes: {
      create: async () => {
        creates++;
      },
    },
  } as unknown as ModalCompilerOptions["client"];
  const compiler = new ModalIsolatedCompiler({ client, appName: "offline", image });
  const input = await request();
  const started = Date.now();
  await expect(
    compiler.compile({ ...input, policy: { ...input.policy, deadlineMs: Date.now() + 1_050 } }),
  ).rejects.toThrow("deadline");
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(creates).toBe(0);
});

test("a sandbox allocated after cancellation receives bounded confirmed termination", async () => {
  const controller = new AbortController();
  let allocate: ((sandbox: unknown) => void) | undefined;
  let created: (() => void) | undefined;
  const creating = new Promise<void>((resolve) => {
    created = resolve;
  });
  const terminations: unknown[] = [];
  let ended: (() => void) | undefined;
  const terminated = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const client = {
    apps: { fromName: async () => ({}) },
    images: { fromRegistry: () => ({}) },
    sandboxes: {
      create: () => {
        created?.();
        return new Promise((resolve) => {
          allocate = resolve;
        });
      },
    },
  } as unknown as ModalCompilerOptions["client"];
  const compiler = new ModalIsolatedCompiler({ client, appName: "offline", image });
  const pending = compiler.compile(await request(controller.signal));
  await creating;
  controller.abort();
  await expect(pending).rejects.toThrow();
  allocate?.({
    terminate: async (params: unknown) => {
      terminations.push(params);
      ended?.();
      return 137;
    },
  });
  await terminated;
  expect(terminations).toEqual([{ wait: true }]);
});

test("cancellation during confirmed cleanup prevents returning a prepared compilation", async () => {
  const controller = new AbortController();
  const fixture = fake({
    termination: async () => {
      controller.abort();
      return 137;
    },
  });
  await expect(fixture.compiler.compile(await request(controller.signal))).rejects.toThrow();
  expect(fixture.snapshot().terminations).toEqual([{ wait: true }]);
});

test("deadline expiry during confirmed cleanup prevents returning a prepared compilation", async () => {
  const fixture = fake({
    termination: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return 137;
    },
  });
  const input = await request();
  await expect(
    fixture.compiler.compile({
      ...input,
      policy: { ...input.policy, deadlineMs: Date.now() + 1_100 },
    }),
  ).rejects.toThrow();
  expect(fixture.snapshot().terminations).toEqual([{ wait: true }]);
});
