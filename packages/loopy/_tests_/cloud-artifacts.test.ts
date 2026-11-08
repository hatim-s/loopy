import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  decodeBoundary,
  nodeIdSchema,
  type PutLoopyBody,
  type SourceArtifact,
  validateCompiled,
} from "@loopy/contract";
import { revision } from "@loopy/core";
import { code, loopy } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { Miniflare } from "miniflare";
import { ARTIFACT_LIMITS } from "../../../apps/cloud/src/artifacts";
import { compiledBody } from "./compiled-fixture";

let runtime: Miniflare;

let directory: string;

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "loopy-artifacts-")));

  await mkdir(join(directory, ".loopy/loopies"), { recursive: true });
  await writeFile(
    join(directory, "effect.ts"),
    `export { Effect } from ${JSON.stringify(new URL("../../../node_modules/effect/dist/index.js", import.meta.url).pathname)};`,
  );

  // Give the artifact entry a distinct output name from the service barrel.
  await writeFile(
    join(directory, "artifacts.ts"),
    `export * from ${JSON.stringify(relative(directory, new URL("../../../apps/cloud/src/artifacts", import.meta.url).pathname))};`,
  );

  const built = await Bun.build({
    entrypoints: [
      join(directory, "effect.ts"),
      join(directory, "artifacts.ts"),
      new URL("../../../apps/cloud/src/sql-driver.ts", import.meta.url).pathname,
      new URL("../../runtime/src/service/index.ts", import.meta.url).pathname,
      new URL("../../runtime/src/store/portable.ts", import.meta.url).pathname,
    ],
    target: "browser",
    splitting: true,
    outdir: directory,
    naming: "[name].js",
  });

  if (!built.success || !built.outputs[0]) {
    throw new Error(built.logs.join("\n"));
  }

  runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    modulesRoot: directory,
    compatibilityDate: "2026-07-30",
    r2Buckets: ["BUCKET"],
    r2Persist: false,
    durableObjects: { REGISTRY: { className: "RegistryFixture", useSQLite: true } },
    durableObjectsPersist: false,
    modules: [
      {
        type: "ESModule",
        path: join(directory, "fixture.js"),
        contents: `
      import { ARTIFACT_LIMITS, R2ArtifactRegistry } from "./artifacts.js";
      import { DurableSqlDriver } from "./sql-driver.js";
      import { Effect } from "./effect.js";
      import { makeService, eventStream, apiRoutes, dispatch } from "./index.js";
      import { SqlRunStore } from "./portable.js";
      export class RegistryFixture {
        constructor(state, env) {
          this.state = state; this.env = env;
          this.store = new SqlRunStore(new DurableSqlDriver(state.storage), {
            owner: {identity: {pid: null, host: "fixture"}, isAlive: () => false}
          });
        }
        async fetch(request) {
          const {workspace, operation, args} = await request.json();
          const bucket = operation === "failWrite" ? {
            get: this.env.BUCKET.get.bind(this.env.BUCKET),
            put: (key, ...rest) => {
              if (key.includes("/graphs/")) { throw new Error("R2 write unavailable"); }
              return this.env.BUCKET.put(key, ...rest);
            }
          } : this.env.BUCKET;
          const registry = new R2ArtifactRegistry(this.state.storage, bucket, workspace);
          try {
            let value;
            if (operation === "failWrite") { await Effect.runPromise(registry.save(args[0])); }
            else if (operation === "race") {
              value = await Promise.all(args.map(async body => {
                try { await Effect.runPromise(registry.save(body)); return "saved"; }
                catch (error) { return error.message; }
              }));
            } else if (operation === "forgetSizes") {
              this.state.storage.sql.exec("DELETE FROM artifact_graph_sizes WHERE workspace = ?", workspace);
            } else if (operation === "listSizes") {
              const entries = await Effect.runPromise(registry.listSummaries());
              value = {
                count: entries.length,
                bounded: this.state.storage.sql.exec("SELECT sum(s.bytes) AS bytes FROM artifact_definitions d JOIN artifact_graph_sizes s ON s.workspace = d.workspace AND s.revision = d.revision WHERE d.workspace = ?", workspace).one().bytes <= ARTIFACT_LIMITS.listBytes
              };
            } else if (operation === "serviceChecks" || operation === "httpSave") {
              const store = this.store;
              const service = makeService({
                store, registry: () => Effect.succeed(registry), clock: {now: Date.now},
                canonicalWorkspace: () => Effect.succeed(workspace),
                secrets: {list: () => Effect.succeed([]), set: () => Effect.void, remove: () => Effect.void},
                generateTypes: () => Effect.die(new Error("unused"))
              });
              if(operation === "httpSave") {
                const url = new URL("http://127.0.0.1/api/loopies/"+args[0].graph.name);
                const request = new Request(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(args[0])});
                return await dispatch(apiRoutes({service,store,cwd:workspace,daemon:{pid:null,startedAt:new Date().toISOString(),concurrency:1}}),request,url);
              }
              const before = await Effect.runPromise(store.eventCursor());
              const run = await Effect.runPromise(service.startRun(args[0], {}, workspace));
              const snapshot = await Effect.runPromise(service.runSnapshot(run.id));
              const schedule = await Effect.runPromise(service.putSchedule(args[0], {cron: "* * * * *"}, workspace));
              await Effect.runPromise(service.setScheduleEnabled(args[0], false, workspace));
              const aborter = new AbortController();
              const response = await Effect.runPromise(eventStream(store, service, {after: before.cursor, epoch: before.epoch}, aborter.signal));
              const reader = response.body.getReader();
              await reader.read();
              const frame = new TextDecoder().decode((await reader.read()).value);
              aborter.abort();
              value = {
                slug: run.slug, revision: (await Effect.runPromise(store.getRun(run.id))).revision,
                snapshotRead: snapshot.run.id === run.id, scheduled: schedule.slug,
                enabled: (await Effect.runPromise(service.listSchedules(workspace)))[0].enabled,
                eventDelivered: frame.includes(run.id) && frame.includes("event: txn")
              };
            } else if (operation === "fillCapacity") {
              this.state.storage.transactionSync(() => {
                for (let index = 0; index < args[0]; index++) {
                  this.state.storage.sql.exec(
                    "INSERT INTO artifact_definitions (workspace, slug, revision, source, saved_at, generation) VALUES (?, ?, ?, ?, ?, ?)",
                    workspace, "seed-" + index, "a".repeat(64), "/seed.ts", "now", "seed"
                  );
                }
              });
            } else { value = await Effect.runPromise(registry[operation](...args)); }
            return Response.json({value: value ?? null});
          } catch (error) { return Response.json({error: error.message}, {status: 400}); }
        }
      }
      export default { fetch(request, env) {
        return env.REGISTRY.get(env.REGISTRY.idFromName("registry-test")).fetch(request);
      }};
    `,
      },
      ...(await Promise.all(
        built.outputs.map(async (output) => ({
          type: "ESModule" as const,
          path: output.path,
          contents: await output.text(),
        })),
      )),
    ],
  });
  await runtime.ready;
});

afterAll(async () => {
  try {
    await runtime?.dispose();
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function call(workspace: string, operation: string, ...args: unknown[]) {
  const response = await runtime.dispatchFetch("http://local/registry", {
    method: "POST",
    body: JSON.stringify({ workspace, operation, args }),
  });

  const body: unknown = await response.json();

  return { status: response.status, body };
}

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
    bundles: [{ nodeId: node.id, bundleHash, bytes: bytes.toString("base64") }],
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
    body: { value: first.bundles[0]?.bytes },
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

  const bucket = await runtime.getR2Bucket("BUCKET");
  const objects = await bucket.list({ prefix: `workspaces/${encodeURIComponent(workspace)}/` });
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

test("capacity rejects overflow without truncating list results", async () => {
  expect(await call("capacity", "fillCapacity", ARTIFACT_LIMITS.definitions)).toMatchObject({
    status: 200,
  });
  const body = await compiledBody("overflow", "/entry.ts", { workspace: "capacity" });
  expect(await call("capacity", "save", body)).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("1000 definition capacity") },
  });
  expect(await call("overfull", "fillCapacity", ARTIFACT_LIMITS.definitions + 1)).toMatchObject({
    status: 200,
  });
  expect(await call("overfull", "listSummaries")).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("1000 definition capacity") },
  });
});

const capacityError = expect.stringContaining(
  "Workspace exceeds its 32 MiB current graph capacity. Replace a definition with a smaller graph before saving.",
);

test("aggregate capacity rejects new and replacement pointers while existing operations remain readable", async () => {
  const workspace = "aggregate";
  const description = "x".repeat(800_000);
  const first = await compiledBody("definition-0", "/entry.ts", { workspace, description });

  for (let index = 0; index < 43; index++) {
    const body = await compiledBody(`definition-${index}`, "/entry.ts", { workspace, description });
    expect(await call(workspace, "save", body)).toMatchObject(
      index < 41 ? { status: 200 } : { status: 400, body: { error: capacityError } },
    );
  }

  expect(await call(workspace, "listSizes")).toEqual({
    status: 200,
    body: { value: { count: 41, bounded: true } },
  });
  expect(await call(workspace, "get", "definition-41")).toEqual({
    status: 200,
    body: { value: null },
  });
  expect(await call(workspace, "get", first.graph.name)).toMatchObject({
    status: 200,
    body: { value: { revision: first.revision } },
  });

  // Discard only the additive metadata to exercise already published pointers after reopening.
  expect(await call(workspace, "forgetSizes")).toMatchObject({ status: 200 });

  const oversizedReplacement = await compiledBody("definition-0", "/entry.ts", {
    workspace,
    description: "x".repeat(1_000_000),
  });

  const equalReplacement = await compiledBody("definition-0", "/entry.ts", {
    workspace,
    description: "y".repeat(800_000),
  });

  expect(await call(workspace, "save", oversizedReplacement)).toMatchObject({ status: 200 });

  const otherReplacement = await compiledBody("definition-1", "/entry.ts", {
    workspace,
    description: "x".repeat(1_000_000),
  });

  expect(await call(workspace, "save", otherReplacement)).toMatchObject({ status: 200 });

  const thirdReplacement = await compiledBody("definition-2", "/entry.ts", {
    workspace,
    description: "x".repeat(1_000_000),
  });

  expect(await call(workspace, "save", thirdReplacement)).toMatchObject({ status: 200 });

  const crossingReplacement = await compiledBody("definition-3", "/entry.ts", {
    workspace,
    description: "x".repeat(1_000_000),
  });

  expect(await call(workspace, "save", crossingReplacement)).toMatchObject({
    status: 400,
    body: { error: capacityError },
  });
  expect(await call(workspace, "get", "definition-3")).toMatchObject({
    body: { value: { graph: { meta: { description } } } },
  });
  expect(await call(workspace, "save", equalReplacement)).toMatchObject({ status: 200 });
  expect(await call(workspace, "get", "definition-0")).toMatchObject({
    body: { value: { revision: equalReplacement.revision } },
  });
  expect(await call(workspace, "serviceChecks", "definition-0")).toMatchObject({
    status: 200,
    body: {
      value: {
        slug: "definition-0",
        revision: equalReplacement.revision,
        snapshotRead: true,
        scheduled: "definition-0",
        enabled: false,
        eventDelivered: true,
      },
    },
  });
  const smaller = await compiledBody("definition-0", "/entry.ts", { workspace });
  expect(await call(workspace, "save", smaller)).toMatchObject({ status: 200 });

  const previouslyRejected = await compiledBody("definition-41", "/entry.ts", {
    workspace,
    description,
  });

  expect(await call(workspace, "save", previouslyRejected)).toMatchObject({ status: 200 });
  expect(await call(workspace, "listSizes")).toEqual({
    status: 200,
    body: { value: { count: 42, bounded: true } },
  });
}, 60_000);

test("concurrent publications compete for aggregate capacity in the pointer transaction", async () => {
  const workspace = "aggregate-race";
  const description = "x".repeat(800_000);

  for (let index = 0; index < 40; index++) {
    const body = await compiledBody(`definition-${index}`, "/entry.ts", { workspace, description });
    expect(await call(workspace, "save", body)).toMatchObject({ status: 200 });
  }

  const contenders = await Promise.all(
    [40, 41].map((index) =>
      compiledBody(`definition-${index}`, "/entry.ts", { workspace, description }),
    ),
  );

  expect(await call(workspace, "race", ...contenders)).toEqual({
    status: 200,
    body: { value: expect.arrayContaining(["saved", capacityError]) },
  });
  expect(await call(workspace, "listSizes")).toMatchObject({
    status: 200,
    body: { value: { count: 41 } },
  });
}, 60_000);

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
  const bucket = await runtime.getR2Bucket("BUCKET");
  const hash = "b".repeat(64);
  await bucket.put(
    `workspaces/${workspace}/graphs/${hash}.json`,
    "x".repeat(ARTIFACT_LIMITS.graphBytes + 1),
  );
  expect(await call(workspace, "revisionGraph", hash)).toMatchObject({
    status: 400,
    body: { error: expect.stringContaining("Object exceeds its 1048576 byte limit.") },
  });
});

test("shared validation rejects forged bundles, revisions and source mappings before storage", async () => {
  const body = await executable("validation");
  await expect(
    Effect.runPromise(validateCompiled({ ...body, revision: "f".repeat(64) })),
  ).rejects.toThrow("The graph revision does not match its contents.");
  await expect(Effect.runPromise(validateCompiled({ ...body, bundles: [] }))).rejects.toThrow(
    "Supply exactly one bundle for each code node and parser in node order.",
  );
  await expect(
    Effect.runPromise(
      validateCompiled({
        ...body,
        bundles: body.bundles.map((bundle) => ({ ...bundle, bytes: btoa("wrong") })),
      }),
    ),
  ).rejects.toThrow("Bundle bytes do not match their hash.");
  await expect(
    Effect.runPromise(
      validateCompiled({ ...body, sourceArtifact: artifact("f".repeat(64), "wrong") }),
    ),
  ).rejects.toThrow("Source must name this compiled revision and its graph nodes.");
  const source = artifact(body.revision, "source");

  if (source.status !== "available") {
    throw new Error("Fixture requires source files.");
  }

  source.ranges = [
    {
      nodeId: decodeBoundary(nodeIdSchema)("missing-node"),
      fileId: "file-0",
      startLine: 1,
      endLine: 2,
    },
  ];
  await expect(
    Effect.runPromise(validateCompiled({ ...body, sourceArtifact: source })),
  ).rejects.toThrow("Source must name this compiled revision and its graph nodes.");
  source.ranges = [
    {
      nodeId: decodeBoundary(nodeIdSchema)("missing-node"),
      fileId: "file-0",
      startLine: 1,
      endLine: 1,
    },
  ];
  await expect(
    Effect.runPromise(validateCompiled({ ...body, sourceArtifact: source })),
  ).rejects.toThrow("Source must name this compiled revision and its graph nodes.");
  expect(await call("validation", "save", { ...body, revision: "f".repeat(64) })).toMatchObject({
    status: 400,
  });
  expect(await call("validation", "listSummaries")).toMatchObject({ body: { value: [] } });
});

test("HTTP capacity rejection retains bad_request and an actionable message", async () => {
  const workspace = "capacity-http";
  expect((await call(workspace, "fillCapacity", 1000)).status).toBe(200);
  const body = await compiledBody("overflow", "/overflow.ts", { workspace });
  expect(await call(workspace, "httpSave", body)).toMatchObject({
    status: 400,
    body: {
      error: { code: "bad_request", message: expect.stringContaining("1000 definition capacity") },
    },
  });
});
