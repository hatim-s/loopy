import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnershipError } from "@loopy/core";
import { activateDurable, type DurableActivationResult } from "@loopy/runtime/host";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect } from "effect";
import { BunSqlDriver } from "../../runtime/src/store/sqlite/bun-driver";
import { newRun } from "./fixture";
import { PolicyProvider, policyGraph, policyRetry, policySuccess } from "./host-policy-fixture";
import { initialModel, type ModelAction, modelStep } from "./host-policy-model";
import { NEVER_ALIVE, runAt } from "./store-fixture";

export function policyStore(file = ":memory:") {
  return new SqlRunStore(new BunSqlDriver(file), { leaseMs: 3000, owner: NEVER_ALIVE });
}

export async function withFilePolicyStore(use: (store: SqlRunStore) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "loopy-host-model-"));
  const store = policyStore(join(root, "runs.sqlite"));

  try {
    await use(store);
  } finally {
    await Effect.runPromise(store.close());
    rmSync(root, { recursive: true, force: true });
  }
}

// Each trace replays as its own run, so one store serves every trace of a search.
export async function replayPolicy(
  trace: ModelAction[],
  store: SqlRunStore,
  runId: string,
  maxWork: number,
) {
  let model = initialModel();
  const at = () => new Date(Date.parse(newRun().createdAt) + model.now).toISOString();
  const run = runAt(() => Date.parse(at()));

  const provider = new PolicyProvider();
  const admit = provider.start.bind(provider);
  provider.start = (key, attempt) => {
    return Effect.gen(function* () {
      expect(yield* store.getNodeRun(key)).toMatchObject({ status: "running", attempt });

      return yield* admit(key, attempt);
    }).pipe(Effect.orDie);
  };

  const graph = policyGraph();
  const codeNode = graph.nodes.find((node) => node.kind === "code");

  if (!codeNode) {
    throw new Error("Expected execution node.");
  }

  await run(store.createRun({ ...newRun(), id: runId }));
  let cursor: string | null = null;

  try {
    for (const action of trace) {
      const expected = modelStep(model, action);
      const lookup = provider.lookup.bind(provider);
      const start = provider.start.bind(provider);
      const release = store.release.bind(store);
      let error: string | null = null;

      switch (action) {
        case "advance":
        case "reconstruct":
          break;
        case "finish":
        case "retry":
        case "vanish": {
          const started = provider.starts.at(-1);

          if (!started) {
            throw new Error("Expected admitted execution.");
          }

          const id = provider.id(started.key, started.attempt);

          if (action === "vanish") {
            provider.receipts.delete(id);
          } else {
            provider.receipts.set(id, {
              kind: "finished",
              result: action === "finish" ? policySuccess : policyRetry,
            });
          }

          break;
        }

        case "signal": {
          const hook = (await run(store.getWaits(runId)))[0];

          if (!hook) {
            throw new Error("Expected registered hook.");
          }

          expect(
            await run(store.resolveWait({ token: hook.token, payload: true, at: at() })),
          ).toMatchObject({ kind: "resolved" });
          break;
        }

        default: {
          if (action === "lookup_loss") {
            provider.lookup = () => {
              return Effect.gen(function* () {
                throw new Error("lookup unavailable");
              }).pipe(Effect.orDie);
            };
          }

          if (action === "start_loss") {
            provider.start = (key, attempt) => {
              return Effect.gen(function* () {
                yield* start(key, attempt);
                throw new Error("start response lost");
              }).pipe(Effect.orDie);
            };
          }

          if (action === "release_loss") {
            store.release = () => {
              return Effect.gen(function* () {
                throw new Error("release interrupted");
              });
            };
          }

          try {
            const result: DurableActivationResult = await run(
              activateDurable({
                store,
                provider,
                graph,
                runId,
                token: `owner${model.token}`,
                at: at(),
                maxWork,
                pollMs: 1000,
                cursor,
              }),
            );

            cursor = result.cursor;
          } catch (cause) {
            if (!(cause instanceof Error)) {
              throw cause;
            }

            error = cause instanceof OwnershipError ? "ownership" : cause.message;
          } finally {
            provider.lookup = lookup;
            provider.start = start;
            store.release = release;
          }
        }
      }

      model = expected.state;
      expect(error).toBe(expected.error);
      const record = await run(store.getRun(runId));
      expect(record?.status).toBe(model.run);
      expect(record?.owner?.token ?? null).toBe(
        model.owner === null ? null : `owner${model.owner}`,
      );

      if (model.owner !== null) {
        expect(record?.owner?.heartbeatAt).toBe(
          new Date(Date.parse(newRun().createdAt) + model.heartbeat).toISOString(),
        );
      }

      const node = await run(store.getNodeRun({ runId, nodeId: codeNode.id, scope: [] }));

      expect(node?.status ?? "new").toBe(model.node);
      expect(node?.attempt ?? 0).toBe(model.attempt);
      expect(provider.starts).toHaveLength(model.starts);
      expect(new Set(provider.starts.map((item) => provider.id(item.key, item.attempt))).size).toBe(
        model.starts,
      );
      expect((await run(store.getLogs(runId))).map((log) => log.message)).toEqual(model.logs);
      const hook = (await run(store.getWaits(runId)))[0];
      expect(
        hook ? (hook.resolvedAt ? "resolved" : hook.expiredAt ? "expired" : "waiting") : "new",
      ).toBe(model.wait);

      if (model.node === "running") {
        expect(node?.receipt).toBe(model.knownStarted ? "started" : "none");
      }
    }
  } catch (cause) {
    throw new Error(`Counterexample budget=${maxWork}: ${trace.join(" -> ")}`, { cause });
  }
}
