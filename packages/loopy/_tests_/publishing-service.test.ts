import { expect, test } from "bun:test";
import type { ArtifactStore, WorkflowCatalog, WorkflowVersion } from "../src/application/ports.js";
import { hashContent, preparePublishBundle } from "../src/publishing/manifest.js";
import { type CompileRequest, PublishingService } from "../src/publishing/service.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const runtime = { build: "runtime@1", graphSchema: 1 as const };
const expected = { compiler: "compiler@1", runtime, imageDigest };
const workflow = {
  version: 1,
  slug: "demo",
  nodes: [
    { id: "read", kind: "command", command: { program: "cat", args: [{ $file: "source.ts" }] } },
  ],
};
const bundle = () =>
  preparePublishBundle(
    {
      entrypoint: "main.ts",
      files: ["main.ts", "bun.lock"],
      lockfile: "bun.lock",
      sources: [{ source: "source.ts", target: "main.ts" }],
      compiler: expected.compiler,
      runtime,
    },
    async () => new TextEncoder().encode("contents"),
  );
function stores() {
  const stored: Uint8Array[] = [];
  const versions: WorkflowVersion[] = [];
  const artifacts: ArtifactStore = {
    scope: { tenantId: "tenant" },
    put: async (bytes) => {
      stored.push(bytes);
      const sha256 = await hashContent(bytes);
      return { id: sha256, sha256, bytes: bytes.byteLength };
    },
    get: async () => undefined,
  };
  const catalog: WorkflowCatalog = {
    scope: { tenantId: "tenant" },
    getVersion: async () => undefined,
    publish: async (version) => {
      versions.push(version);
      return version;
    },
  };
  return { artifacts, catalog, stored, versions };
}

test("compiler absence and rejected identities write no artifacts or runnable versions", async () => {
  const ports = stores();
  await expect(
    new PublishingService({ ...ports, expected }).publish(await bundle()),
  ).rejects.toThrow("not configured");
  let compiles = 0;
  const compiler = {
    compile: async () => {
      compiles++;
      return { workflow, imageDigest };
    },
  };
  await expect(
    new PublishingService({
      ...ports,
      expected: { ...expected, compiler: "different" },
      compiler,
    }).publish(await bundle()),
  ).rejects.toThrow("unsupported");
  expect(compiles).toBe(0);
  expect(ports.stored).toHaveLength(0);
  expect(ports.versions).toHaveLength(0);
});

test("publication validates compiler graph, maps explicit files and persists immutable compilation inputs", async () => {
  const ports = stores();
  let request: CompileRequest | undefined;
  const service = new PublishingService({
    ...ports,
    expected,
    compiler: {
      compile: async (value) => {
        request = value;
        return { workflow, imageDigest };
      },
    },
  });
  const version = await service.publish(await bundle());
  expect(request?.policy.serviceCredentials).toBe(false);
  expect(request?.policy.maxOutputBytes).toBe(1024 * 1024);
  expect(version.workflow.nodes[0]).toEqual({
    id: "read",
    kind: "command",
    command: { program: "cat", args: [{ $file: "main.ts" }] },
  });
  expect(version.files).toHaveLength(2);
  expect(version.publication?.bundle.sha256).toBe(version.id);
  expect(version.publication?.sourceMappings).toEqual([{ source: "source.ts", target: "main.ts" }]);
  expect(ports.versions).toEqual([version]);
  const last = ports.stored.at(-1);
  expect(last).toBeDefined();
  const compiled = JSON.parse(new TextDecoder().decode(last));
  expect(compiled.bundle.manifest.sources).toEqual([{ source: "source.ts", target: "main.ts" }]);
  expect(compiled.graphHash).toBe(version.graphHash);
});

test("malformed compiler results never publish or upload", async () => {
  for (const result of [
    { workflow, imageDigest: "latest" },
    { workflow: { version: 1, slug: "demo", nodes: [] }, imageDigest },
    {
      workflow: {
        ...workflow,
        nodes: [
          {
            id: "read",
            kind: "command",
            command: { program: "cat", args: [{ $file: "../secret" }] },
          },
        ],
      },
      imageDigest,
    },
    {
      workflow: {
        ...workflow,
        nodes: [
          {
            id: "read",
            kind: "command",
            command: { program: "cat", args: [{ $file: "undeclared" }] },
          },
        ],
      },
      imageDigest,
    },
    { workflow: { ...workflow, description: "x".repeat(1024 * 1024) }, imageDigest },
  ]) {
    const ports = stores();
    await expect(
      new PublishingService({
        ...ports,
        expected,
        compiler: { compile: async () => result },
      }).publish(await bundle()),
    ).rejects.toThrow();
    expect(ports.versions).toHaveLength(0);
    expect(ports.stored).toHaveLength(0);
  }
});
