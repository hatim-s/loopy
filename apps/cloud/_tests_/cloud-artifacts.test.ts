import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PutLoopyBody, SourceArtifact } from "@loopy/contract";
import { revision } from "@loopy/core";
import { code, loopy } from "@loopy/sdk";
import { compiledBody } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { ARTIFACT_LIMITS } from "../src/artifacts";
import { r2Key } from "../src/artifacts/storage";
import { type ArtifactRegistry, artifactRegistry } from "./fixtures/artifact-registry";

let registry: ArtifactRegistry;

beforeAll(async () => {
  registry = await artifactRegistry("artifacts");
}, 60_000);

afterAll(async () => {
  await registry?.cleanup();
});

const call = (workspace: string, operation: string, ...args: unknown[]) =>
  registry.call(workspace, operation, ...args);

function artifact(hash: string, content: string): SourceArtifact {
  return {
    version: 1,
    status: "available",
    revision: hash,
    files: [{ id: "file-0", path: "entry.ts", content }],
    ranges: [],
  };
}

async function executable(workspace: string): Promise<PutLoopyBody> {
  const graph = loopy("executable", {
    input: {},
    run: () =>
      code("execute", { in: {}, module: "./entry.ts", out: { kind: "value", type: "string" } }),
  });

  delete graph.inputValidation;

  const node = graph.nodes.find((candidate) => candidate.kind === "code");

  if (!node) {
    throw new Error("Fixture requires a code node.");
  }

  const bytes = Buffer.from('export default () => "✓";');
  const bundleHash = createHash("sha256").update(bytes).digest("hex");
  node.module.bundleHash = bundleHash;

  return {
    graph,
    revision: await revision(graph),
    replace: false,
    bundles: [{ nodeId: node.id, bundleHash, bytes: Uint8Array.from(bytes) }],
    source: { path: "/entry.ts", workspace },
  };
}

test("real local R2 and DO SQL publish immutable revisions, pinned source and base64 bundles", async () => {
  const workspace = "artifacts/history";
  const first = await executable(workspace);
  first.sourceArtifact = artifact(first.revision, "original source");
  expect(await call(workspace, "save", first)).toMatchObject({ status: 200 });
  const saved = await call(workspace, "get", first.graph.name);
  expect(saved).toMatchObject({
    status: 200,
    body: { value: { revision: first.revision, graph: first.graph } },
  });
  expect(await call(workspace, "getBundle", first.bundles[0]?.bundleHash)).toMatchObject({
    status: 200,
    body: { value: Buffer.from(first.bundles[0]?.bytes ?? []).toString("base64") },
  });
  expect(
    await call(workspace, "save", {
      ...first,
      sourceArtifact: artifact(first.revision, "later source"),
    }),
  ).toMatchObject({ status: 200 });
  expect(await call(workspace, "get", first.graph.name)).toEqual(saved);
  expect(await call(workspace, "revisionSource", first.graph.name, first.revision)).toMatchObject({
    body: { value: first.sourceArtifact },
  });

  const changed = structuredClone(first);
  changed.graph.meta.description = "new revision";
  changed.revision = await revision(changed.graph);
  changed.sourceArtifact = artifact(changed.revision, "new source");
  expect(await call(workspace, "save", changed)).toMatchObject({ status: 200 });
  expect(await call(workspace, "revisionGraph", first.revision)).toMatchObject({
    body: { value: first.graph },
  });
  expect(await call(workspace, "listSummaries")).toMatchObject({
    body: { value: [{ revision: changed.revision }] },
  });
  expect(await call(workspace, "workspace")).toMatchObject({ body: { value: workspace } });

  const bucket = await registry.bucket();
  const objects = await bucket.list({ prefix: r2Key.workspace(workspace) });
  expect(objects.objects).toHaveLength(5);
});

test("missing source is pinned and workspaces cannot read another tenant's artifacts", async () => {
  const body = await executable("tenant-a");
  expect(await call("tenant-a", "save", body)).toMatchObject({ status: 200 });
  expect(
    await call("tenant-a", "save", { ...body, sourceArtifact: artifact(body.revision, "late") }),
  ).toMatchObject({ status: 200 });
  expect(await call("tenant-a", "revisionSource", body.graph.name, body.revision)).toMatchObject({
    body: { value: { status: "unavailable", reason: "not_captured" } },
  });
  expect(await call("tenant-b", "revisionGraph", body.revision)).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("Published graph is missing. Save the loopy again.") },
  });
  expect(await call("tenant-b", "getBundle", body.bundles[0]?.bundleHash)).toMatchObject({
    status: 400,
  });
  expect(await call("tenant-b", "save", body)).toMatchObject({
    status: 400,
    body: {
      error: expect.stringContaining(
        "Source workspace does not match the authenticated workspace.",
      ),
    },
  });
  expect(await call("tenant-b", "listSummaries")).toMatchObject({ body: { value: [] } });
});

test("artifact failures never publish metadata and a later retry finishes publication", async () => {
  const body = await executable("failure");
  expect(await call("failure", "failWrite", body)).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("R2 write unavailable") },
  });
  expect(await call("failure", "listSummaries")).toMatchObject({ body: { value: [] } });
  expect(await call("failure", "save", body)).toMatchObject({ status: 200 });
  expect(await call("failure", "get", body.graph.name)).toMatchObject({
    body: { value: { revision: body.revision } },
  });
});

test("final SQL transaction rejects source ownership races and explicit replace changes owners", async () => {
  const body = await compiledBody("owned", "/first.ts", { workspace: "race" });
  const contender = { ...body, source: { path: "/second.ts", workspace: "race" } };
  const result = await call("race", "race", body, contender);
  expect(result).toMatchObject({
    body: {
      value: expect.arrayContaining([
        "saved",
        "Slug 'owned' belongs to another source. Rename it or use --replace.",
      ]),
    },
  });
  expect(await call("race", "get", "owned")).toMatchObject({
    body: { value: { source: expect.stringMatching(/^\/(first|second)\.ts$/) } },
  });
  expect(await call("race", "save", { ...contender, replace: true })).toMatchObject({
    status: 200,
  });
  expect(await call("race", "get", "owned")).toMatchObject({
    body: { value: { source: "/second.ts" } },
  });

  const newer = structuredClone(contender);
  newer.replace = true;
  newer.graph.meta.description = "next";
  newer.revision = await revision(newer.graph);
  const older = { ...body, replace: true };
  expect(await call("race", "race", newer, older)).toMatchObject({
    body: {
      value: expect.arrayContaining([
        "saved",
        "The definition changed during save. Retry against its current source owner.",
      ]),
    },
  });
});

test("cloud rejects unsupported modes, declared secrets, oversized writes and bounded R2 reads", async () => {
  const workspace = "limits";

  for (const meta of [{ mode: "full" as const }, { secrets: ["TOKEN"] }]) {
    const body = await compiledBody("unsupported", "/entry.ts", { ...meta, workspace });
    expect(await call(workspace, "save", body)).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("sandbox mode without declared secrets") },
    });
  }

  const body = await compiledBody("large", "/entry.ts", { workspace });
  body.graph.meta.description = "x".repeat(ARTIFACT_LIMITS.graphBytes);
  expect(await call(workspace, "save", body)).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("Compiled artifacts exceed cloud limits") },
  });
  const bucket = await registry.bucket();
  const hash = "b".repeat(64);
  await bucket.put(
    r2Key.workspace(workspace) + r2Key.graph(hash),
    "x".repeat(ARTIFACT_LIMITS.graphBytes + 1),
  );
  expect(await call(workspace, "revisionGraph", hash)).toMatchObject({
    status: 400,
    body: {
      error: expect.stringContaining(
        `Object exceeds its ${ARTIFACT_LIMITS.graphBytes} byte limit.`,
      ),
    },
  });
});

test("cloud save rejects a forged revision before storage", async () => {
  const body = await executable("validation");
  expect(await call("validation", "save", { ...body, revision: "f".repeat(64) })).toMatchObject({
    status: 400,
  });
  expect(await call("validation", "listSummaries")).toMatchObject({ body: { value: [] } });
});
