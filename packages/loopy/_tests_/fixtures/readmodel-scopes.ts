import { Effect } from "effect";
import { decodeBoundary, nodeIdSchema } from "../../src/contract/index.js";
import type { NodeRun, Store } from "../../src/core/index.js";
import { readmodelAt } from "./readmodel-history.js";

export async function seedScopes(store: Store) {
  for (const id of ["scope-run", "other-run"]) {
    await Effect.runPromise(
      store.createRun({
        id,
        workspace: "synthetic",
        slug: "scope",
        revision: "synthetic-revision",
        input: null,
        status: "queued",
        createdAt: readmodelAt,
        updatedAt: readmodelAt,
      }),
    );
    await Effect.runPromise(store.claim(id, "owner"));
  }

  const nodes: NodeRun[] = [];

  for (let ordinal = 0; ordinal < 213; ordinal++) {
    const key = {
      runId: "scope-run",
      nodeId: decodeBoundary(nodeIdSchema)("done"),
      scope: [{ nodeId: decodeBoundary(nodeIdSchema)("map"), index: ordinal * 2 }],
    };

    const base = { attempt: 1, maxAttempts: 1, startedAt: readmodelAt };
    nodes.push({
      ...base,
      key,
      status: "succeeded",
      receipt: "finished",
      output: null,
      endedAt: readmodelAt,
    });

    if (ordinal % 10 !== 0) {
      nodes.push({
        ...base,
        key: { ...key, nodeId: decodeBoundary(nodeIdSchema)("approval") },
        status: "waiting",
        receipt: "none",
        wakeAt: null,
      });
    }

    if (ordinal % 3 === 0) {
      nodes.push({
        ...base,
        key: { ...key, nodeId: decodeBoundary(nodeIdSchema)("error") },
        status: "failed",
        receipt: "finished",
        error: { code: "execution", message: "controlled failure" },
        endedAt: readmodelAt,
      });
    }
  }

  const first = nodes[0];

  if (!first) {
    throw new Error("Missing synthetic scope item.");
  }

  nodes.push({
    ...first,
    key: { ...first.key, scope: [{ nodeId: decodeBoundary(nodeIdSchema)("other-map"), index: 0 }] },
  });
  nodes.push({
    ...first,
    key: {
      ...first.key,
      scope: [{ nodeId: decodeBoundary(nodeIdSchema)("outer"), index: 1 }, ...first.key.scope],
    },
  });
  await Effect.runPromise(
    store.apply({
      runId: "scope-run",
      token: "owner",
      effects: nodes.map((nodeRun) => ({ kind: "write_node_run", nodeRun })),
    }),
  );
  await Effect.runPromise(
    store.apply({
      runId: "other-run",
      token: "owner",
      effects: [
        {
          kind: "write_node_run",
          nodeRun: { ...first, key: { ...first.key, runId: "other-run" } },
        },
      ],
    }),
  );
}
