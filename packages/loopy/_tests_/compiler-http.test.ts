import { expect, test } from "bun:test";
import { createCompilerHandler } from "../src/providers/compiler-service.js";
import { HttpIsolatedCompiler } from "../src/publishing/compiler-http.js";
import { preparePublishBundle } from "../src/publishing/manifest.js";
import type { CompileRequest } from "../src/publishing/service.js";

const workflow = {
  version: 1,
  slug: "example",
  nodes: [{ id: "first", kind: "command", command: { program: "echo", args: ["hello"] } }],
};
const result = { workflow, imageDigest: `sha256:${"a".repeat(64)}` };
async function input(signal = new AbortController().signal): Promise<CompileRequest> {
  return {
    bundle: await preparePublishBundle(
      {
        entrypoint: "main.ts",
        files: ["main.ts", "bun.lock", "package.json"],
        lockfile: "bun.lock",
        sources: [],
        compiler: "compiler@1",
        runtime: { build: "runtime@1", graphSchema: 1 },
      },
      async () => new TextEncoder().encode("contents"),
    ),
    signal,
    policy: {
      deadlineMs: Date.now() + 60_000,
      maxOutputBytes: 100_000,
      serviceCredentials: false,
      dependencies: "locked-only",
    },
  };
}

test("authenticated compiler HTTP transport preserves the canonical request without forwarding credentials", async () => {
  let received: CompileRequest | undefined;
  const handler = createCompilerHandler({
    serviceToken: "internal-service-token",
    compiler: {
      compile: async (request) => {
        received = request;
        return result;
      },
    },
  });
  const compiler = new HttpIsolatedCompiler({
    origin: "https://compiler.example",
    serviceToken: "internal-service-token",
    fetch: async (url, options) => {
      expect(String(url)).toBe("https://compiler.example/compile");
      expect(options?.redirect).toBe("error");
      expect(options?.credentials).toBe("omit");
      return handler(new Request(url, options));
    },
  });
  const request = await input();
  expect(await compiler.compile(request)).toEqual(result);
  expect(received?.bundle.sha256).toBe(request.bundle.sha256);
  expect(received?.policy).toEqual(request.policy);
  expect(JSON.stringify(received)).not.toContain("internal-service-token");
});

test("compiler service authentication fails before evaluation and returns no token or submitted source", async () => {
  let compiles = 0;
  const handler = createCompilerHandler({
    serviceToken: "configured-service-token",
    compiler: {
      compile: async () => {
        compiles++;
        return result;
      },
    },
  });
  const response = await handler(
    new Request("https://compiler.example/compile", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: "source",
    }),
  );
  expect(response.status).toBe(401);
  expect(compiles).toBe(0);
  expect(await response.text()).toBe('{"error":"Unauthorized"}');
});

test("compiler HTTP cancellation reaches evaluation and prevents a late result", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const handler = createCompilerHandler({
    serviceToken: "token",
    compiler: {
      compile: async (request) => {
        signal = request.signal;
        controller.abort();
        return new Promise(() => {});
      },
    },
  });
  const compiler = new HttpIsolatedCompiler({
    origin: "https://compiler.example",
    serviceToken: "token",
    fetch: (url, options) => handler(new Request(url, options)),
  });
  await expect(compiler.compile(await input(controller.signal))).rejects.toThrow();
  expect(signal?.aborted).toBe(true);
});

test("compiler service and client bound response bytes and sanitize internal failures", async () => {
  const request = await input();
  const handler = createCompilerHandler({
    serviceToken: "token",
    compiler: { compile: async () => ({ ...result, workflow: { source: "x".repeat(128_001) } }) },
  });
  const response = await handler(
    new Request("https://compiler.example/compile", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: JSON.stringify({ bundle: request.bundle, policy: request.policy }),
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.text()).toBe('{"error":"Isolated compilation failed"}');
  await expect(
    new HttpIsolatedCompiler({
      origin: "https://compiler.example",
      serviceToken: "token",
      fetch: async () => new Response("x".repeat(128_001)),
    }).compile(request),
  ).rejects.toThrow("exceeds");
});

test("compiler body ingestion stops a pending read on cancellation or its own host timeout", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    let compiles = 0;
    const handler = createCompilerHandler({
      serviceToken: "token",
      bodyTimeoutMs: 10,
      compiler: {
        compile: async () => {
          compiles++;
          return result;
        },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://compiler.example/compile", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body,
      signal: controller.signal,
    });
    const pending = handler(request);
    if (cancel) controller.abort();
    const response = await pending;
    expect(response.status).toBe(422);
    expect(cancelled).toBe(true);
    expect(compiles).toBe(0);
  }
});
