import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { CLOUD_MAX_REQUEST_BYTES, decodeBoundary, nodeIdSchema, PAGE_LIMIT } from "@loopy/contract";
import { apiRoutes, dispatch, makeService } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect } from "effect";
import { runIn } from "../../../../packages/core/_tests_/fixtures/run";
import { R2ArtifactRegistry } from "../../src/artifacts";
import { DurableSqlDriver } from "../../src/sql-driver";

const at = "2026-10-22T00:00:00.000Z";

// One full page of waiting runs, then runs whose waits are resolved, expired, due or absent.
const TOTAL = PAGE_LIMIT + 5;

// The service reads the wall clock, so a pending deadline lies far ahead of it.
const later = "2126-10-22T01:00:00.000Z";

async function seed(store: SqlRunStore) {
  const hooks = [];

  for (let index = 0; index < TOTAL; index++) {
    const id = `page-${String(index).padStart(3, "0")}`;

    const record = runIn(index === PAGE_LIMIT + 4 ? "succeeded" : "queued", {
      id,
      slug: "pagination",
      revision: "a".repeat(64),
      workspace: "pagination",
      input: {},
      createdAt: at,
      updatedAt: at,
    });

    await Effect.runPromise(store.createRun(record));

    if (index >= PAGE_LIMIT + 3) {
      continue;
    }

    const key = { runId: id, nodeId: decodeBoundary(nodeIdSchema)("approval"), scope: [] };
    const wakeAt = index === PAGE_LIMIT + 2 ? at : index % 2 === 0 ? later : null;
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
          index === PAGE_LIMIT + 1
            ? { kind: "finish_run", outcome: { status: "succeeded", output: null }, at }
            : { kind: "suspend_run", wakeAt },
        ],
      }),
    );

    const hook = (await Effect.runPromise(store.getWaits(id)))[0];

    if (!hook) {
      throw new Error(`Synthetic hook for '${id}' was not persisted.`);
    }

    if (index === PAGE_LIMIT) {
      await Effect.runPromise(store.resolveWait({ token: hook.token, payload: true, at }));
    }

    hooks.push({ ...(await Effect.runPromise(store.getWaits(id)))[0], expiresAt: wakeAt });
  }

  return { total: TOTAL, hooks };
}

export async function paginationResponse(
  request: Request,
  ctx: DurableObjectState,
  bucket: R2Bucket,
) {
  const store = new SqlRunStore(new DurableSqlDriver(ctx.storage), {
    owner: { identity: { pid: null, host: "pagination-probe" }, isAlive: () => false },
  });

  const url = new URL(request.url);

  if (url.pathname === "/pagination/seed") {
    return Response.json(await seed(store));
  }

  const registry = new R2ArtifactRegistry(ctx.storage, bucket, "pagination");

  const unsupported = () => Effect.die(new Error("Pagination probe only supports run queries."));

  const service = makeService({
    store,
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
    maxBodyBytes: CLOUD_MAX_REQUEST_BYTES,
  });

  url.pathname = "/api/runs";

  return dispatch(table, request, url);
}
