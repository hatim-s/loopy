import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { OwnershipError } from "../src/core";
import { activateDurable, type DurableActivationResult } from "../src/host/durable";
import { MemoryStore } from "../src/store";
import { SqlRunStore } from "../src/store/portable";
import { BunSqlDriver } from "../src/store/sqlite/bun-driver";
import { createSqlSchema } from "../src/store/sqlite/schema";
import { newRun } from "./fixture";
import { PolicyProvider, policyGraph, policyRetry, policySuccess } from "./host-policy-fixture";
import { initialModel, type ModelAction, modelStep } from "./host-policy-model";

export async function replayPolicy(
  trace: ModelAction[],
  backend: "memory" | "sqlite",
  maxWork: number,
) {
  const root = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "loopy-host-model-")) : null;
  let model = initialModel();
  const at = () => new Date(Date.parse(newRun().createdAt) + model.now).toISOString();
  const now = () => Date.parse(at());
  const db = root ? new BunSqlDriver(join(root, "runs.sqlite")) : null;

  if (db) {
    createSqlSchema(db);
  }

  const store = db
    ? new SqlRunStore(db, {
        now,
        leaseMs: 3000,
        owner: { identity: { pid: 0, host: "model" }, isAlive: () => false },
      })
    : new MemoryStore(now, 3000);

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

  await Effect.runPromise(store.createRun(newRun()));
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
          const hook = (await Effect.runPromise(store.getWaits("run")))[0];

          if (!hook) {
            throw new Error("Expected registered hook.");
          }

          expect(
            await Effect.runPromise(
              store.resolveWait({ token: hook.token, payload: true, at: at() }),
            ),
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
            const result: DurableActivationResult = await Effect.runPromise(
              activateDurable({
                store,
                provider,
                graph,
                runId: "run",
                token: `owner${model.token}`,
                at: at(),
                maxWork,
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
      const run = await Effect.runPromise(store.getRun("run"));
      expect(run?.status).toBe(model.run);
      expect(run?.owner?.token ?? null).toBe(model.owner === null ? null : `owner${model.owner}`);

      if (model.owner !== null) {
        expect(run?.owner?.heartbeatAt).toBe(
          new Date(Date.parse(newRun().createdAt) + model.heartbeat).toISOString(),
        );
      }

      const node = await Effect.runPromise(
        store.getNodeRun({ runId: "run", nodeId: codeNode.id, scope: [] }),
      );

      expect(node?.status ?? "new").toBe(model.node);
      expect(node?.attempt ?? 0).toBe(model.attempt);
      expect(provider.starts).toHaveLength(model.starts);
      expect(new Set(provider.starts.map((item) => provider.id(item.key, item.attempt))).size).toBe(
        model.starts,
      );
      expect((await Effect.runPromise(store.getLogs("run"))).map((log) => log.message)).toEqual(
        model.logs,
      );
      const hook = (await Effect.runPromise(store.getWaits("run")))[0];
      expect(
        hook ? (hook.resolvedAt ? "resolved" : hook.expiredAt ? "expired" : "waiting") : "new",
      ).toBe(model.wait);

      if (model.node === "running") {
        expect(node?.receipt).toBe(model.knownStarted ? "started" : "none");
      }
    }
  } catch (cause) {
    throw new Error(`Counterexample ${backend} budget=${maxWork}: ${trace.join(" -> ")}`, {
      cause,
    });
  } finally {
    db?.close();

    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
