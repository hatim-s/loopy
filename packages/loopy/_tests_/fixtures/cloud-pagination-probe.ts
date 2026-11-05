import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { R2ArtifactRegistry } from "../../../../apps/cloud/src/artifacts.js";
import { DurableSqlDriver } from "../../../../apps/cloud/src/sql-driver.js";
import { decodeBoundary, nodeIdSchema } from "../../src/contract/index.js";
import type { RunRecord } from "../../src/core/index.js";
import { apiRoutes, dispatch, makeService } from "../../src/service/index.js";
import { SqlRunStore } from "../../src/store/portable.js";

const at = "2026-10-22T00:00:00.000Z";

const later = "2026-10-22T01:00:00.000Z";

async function seed(store: SqlRunStore) {
  const hooks = [];

  for (let index = 0; index < 205; index++) {
    const id = `page-${String(index).padStart(3, "0")}`;

    const record: RunRecord = {
      id,
      slug: "pagination",
      revision: "a".repeat(64),
      workspace: "pagination",
      input: {},
      status: index === 204 ? "succeeded" : "queued",
      createdAt: at,
      updatedAt: at,
    };

    if (index === 204) {
      record.output = null;
    }

    await Effect.runPromise(store.createRun(record));

    if (index >= 203) {
      continue;
    }

    const key = { runId: id, nodeId: decodeBoundary(nodeIdSchema)("approval"), scope: [] };
    const wakeAt = index === 202 ? at : index % 2 === 0 ? later : null;
    await Effect.runPromise(store.claim(id, "owner"));
    await Effect.runPromise(
      store.apply({
        runId: id,
        token: "owner",
        effects: [
          {
            kind: "write_node_run",
            nodeRun: {
              key,
              attempt: 1,
              maxAttempts: 1,
              receipt: "none",
              startedAt: at,
              status: "waiting",
              wakeAt,
            },
          },
          {
            kind: "register_wait",
            executionKey: key,
            name: `approve-${id}`,
            payload: { kind: "value", type: "boolean" },
            at,
          },
          index === 201
            ? { kind: "finish_run", outcome: { status: "succeeded", output: null }, at }
            : { kind: "suspend_run", wakeAt, at },
        ],
      }),
    );

    const hook = (await Effect.runPromise(store.getWaits(id)))[0];

    if (!hook) {
      throw new Error(`Synthetic hook for '${id}' was not persisted.`);
    }

    if (index === 200) {
      await Effect.runPromise(store.resolveWait({ token: hook.token, payload: true, at }));
    }

    hooks.push({ ...(await Effect.runPromise(store.getWaits(id)))[0], expiresAt: wakeAt });
  }

  return { total: 205, hooks };
}

export async function paginationResponse(
  request: Request,
  ctx: DurableObjectState,
  bucket: R2Bucket,
) {
  const store = new SqlRunStore(new DurableSqlDriver(ctx.storage), {
    owner: { identity: { pid: null, host: "pagination-probe" }, isAlive: () => false },
    now: () => Date.parse(at),
  });

  const url = new URL(request.url);

  if (url.pathname === "/pagination/seed") {
    return Response.json(await seed(store));
  }

  const registry = new R2ArtifactRegistry(ctx.storage, bucket, "pagination");

  const unsupported = () => Effect.die(new Error("Pagination probe only supports run queries."));

  const service = makeService({
    store,
    clock: { now: () => Date.parse(at) },
    registry: () => Effect.succeed(registry),
    canonicalWorkspace: () => Effect.succeed("pagination"),
    secrets: { list: unsupported, set: unsupported, remove: unsupported },
    generateTypes: unsupported,
  });

  const table = apiRoutes({
    service,
    store,
    cwd: "pagination",
    daemon: { pid: null, startedAt: at, concurrency: 1 },
  });

  url.pathname = "/api/runs";

  return dispatch(table, request, url);
}
