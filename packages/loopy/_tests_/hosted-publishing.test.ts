import { expect, test } from "bun:test";
import type { ArtifactStore, WorkflowCatalog, WorkflowVersion } from "../src/application/ports.js";
import { createCompilerHandler } from "../src/providers/compiler-service.js";
import { HostedPublisher } from "../src/publishing/client.js";
import { HttpIsolatedCompiler } from "../src/publishing/compiler-http.js";
import { hashContent, preparePublishBundle } from "../src/publishing/manifest.js";
import type { IsolatedCompiler } from "../src/publishing/service.js";
import { PublishingService } from "../src/publishing/service.js";

const runtime = { build: "runtime@1", graphSchema: 1 as const };
const imageDigest = `sha256:${"a".repeat(64)}`;
const prepare = () =>
  preparePublishBundle(
    {
      entrypoint: "main.ts",
      files: ["main.ts", "bun.lock"],
      sources: [],
      lockfile: "bun.lock",
      compiler: "compiler@1",
      runtime,
    },
    async () => new TextEncoder().encode("source"),
  );
const workflow = {
  version: 1,
  slug: "demo",
  nodes: [{ id: "first", kind: "command", command: { program: "echo", args: ["hello"] } }],
};
async function version(
  compiler: IsolatedCompiler = { compile: async () => ({ workflow, imageDigest }) },
) {
  const artifacts: ArtifactStore = {
    scope: { tenantId: "tenant" },
    get: async () => undefined,
    put: async (bytes) => {
      const sha256 = await hashContent(bytes);
      return { id: sha256, sha256, bytes: bytes.byteLength };
    },
  };
  const catalog: WorkflowCatalog = {
    scope: artifacts.scope,
    getVersion: async () => undefined,
    publish: async (value) => value,
  };
  return new PublishingService({
    artifacts,
    catalog,
    expected: { compiler: "compiler@1", runtime, imageDigest },
    compiler,
  }).publish(await prepare());
}

test("hosted publish sends verified bundle with explicit machine authentication and refuses redirects", async () => {
  const result = await version();
  let called = false;
  const client = new HostedPublisher({
    origin: "https://loopy.example",
    token: "machine-token",
    fetch: async (url, options) => {
      called = true;
      expect(String(url)).toBe("https://loopy.example/versions");
      expect(options?.redirect).toBe("error");
      expect(options?.credentials).toBe("omit");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer machine-token");
      expect(JSON.parse(String(options?.body)).sha256).toBe((await prepare()).sha256);
      return Response.json(result, { status: 201 });
    },
  });
  expect(await client.publish(await prepare())).toEqual(result);
  expect(called).toBe(true);
});

test("invalid origins and missing publishing tokens fail before any request", () => {
  for (const origin of [
    "http://loopy.example",
    "https://user:password@loopy.example",
    "https://loopy.example/path",
    "https://loopy.example?token=x",
  ])
    expect(() => new HostedPublisher({ origin, token: "token" })).toThrow();
  expect(() => new HostedPublisher({ origin: "https://loopy.example", token: "" })).toThrow();
});

test("hosted transport rejects failed, oversized, and mismatched responses without exposing server bodies", async () => {
  const result = await version();
  for (const response of [
    new Response("secret body", { status: 403 }),
    new Response("x".repeat(512_001), { status: 201 }),
    Response.json({ ...result, compiler: "other" }, { status: 201 }),
    Response.json({ ...result, files: [] }, { status: 201 }),
  ]) {
    await expect(
      new HostedPublisher({
        origin: "https://loopy.example",
        token: "token",
        fetch: async () => response,
      }).publish(await prepare()),
    ).rejects.toThrow();
  }
  const client = new HostedPublisher({
    origin: "https://loopy.example",
    token: "sensitive-token",
    fetch: async () => {
      throw new Error("sensitive-token");
    },
  });
  await expect(client.publish(await prepare())).rejects.toThrow("Hosted publishing request failed");
  const mismatch: WorkflowVersion = { ...result, entrypoint: "wrong.ts" };
  await expect(
    new HostedPublisher({
      origin: "https://loopy.example",
      token: "token",
      fetch: async () => Response.json(mismatch, { status: 201 }),
    }).publish(await prepare()),
  ).rejects.toThrow("identity");
});

test("offline publish chain keeps machine publishing and internal compiler credentials separate", async () => {
  let compiles = 0;
  const handler = createCompilerHandler({
    serviceToken: "compiler-only-token",
    compiler: {
      compile: async (request) => {
        compiles++;
        expect(JSON.stringify(request)).not.toContain("token");
        return { workflow, imageDigest };
      },
    },
  });
  const compiler = new HttpIsolatedCompiler({
    origin: "https://compiler.example",
    serviceToken: "compiler-only-token",
    fetch: (url, options) => handler(new Request(url, options)),
  });
  const publisher = new HostedPublisher({
    origin: "https://loopy.example",
    token: "publish-only-token",
    fetch: async (_url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer publish-only-token");
      return Response.json(await version(compiler), { status: 201 });
    },
  });
  expect((await publisher.publish(await prepare())).workflow.slug).toBe("demo");
  expect(compiles).toBe(1);
});

test("hosted publishing recomputes returned graph and compiled artifact identities", async () => {
  const original = await version();
  const changed = {
    ...original,
    workflow: {
      ...original.workflow,
      nodes: [{ id: "first", kind: "command", command: { program: "echo", args: ["changed"] } }],
    },
  };
  const client = (response: unknown) =>
    new HostedPublisher({
      origin: "https://loopy.example",
      token: "token",
      fetch: async () => Response.json(response, { status: 201 }),
    });
  await expect(client(changed).publish(await prepare())).rejects.toThrow("graph hash");
  const { workflowGraphHash } = await import("../src/publishing/identity.js");
  await expect(
    client({
      ...changed,
      graphHash: await workflowGraphHash(changed.workflow as typeof original.workflow),
    }).publish(await prepare()),
  ).rejects.toThrow("compilation identity");
});

test("published workflow snapshot has the exact identity used by run admission", async () => {
  const saved = await version();
  const { prepareRun } = await import("../src/runtime/prepare.js");
  const run = await prepareRun(
    saved.workflow,
    {},
    { workspace: { kind: "managed", id: "workspace" }, mode: "sandbox" },
  );
  expect(run.workflowHash).toBe(saved.graphHash);
  expect(JSON.stringify(run.workflow)).toBe(JSON.stringify(saved.workflow));
});
