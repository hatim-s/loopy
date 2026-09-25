import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore } from "../src/local/store.js";
import type { RunRepository } from "../src/runtime/repository.js";
import { Runtime } from "../src/runtime/runtime.js";

test("a slow final commit does not turn a completed run into an ownership error", async () => {
  const home = mkdtempSync(join(tmpdir(), "loopy-finalization-"));
  const store = new SqliteRunStore(home);
  let heartbeatsAfterCompletion = 0;
  const repository: RunRepository = new Proxy(store, {
    get(target, property) {
      if (property === "heartbeat") {
        return async (...args: Parameters<RunRepository["heartbeat"]>) => {
          const owned = await target.heartbeat(...args);
          if (!owned) heartbeatsAfterCompletion += 1;
          return owned;
        };
      }
      if (property === "finishRun") {
        return async (...args: Parameters<RunRepository["finishRun"]>) => {
          const result = await target.finishRun(...args);
          await Bun.sleep(20);
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const runtime = new Runtime({
      store: repository,
      executor: async () => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 }),
      heartbeatIntervalMs: 1,
    });
    const run = await runtime.createRun(
      {
        version: 1,
        slug: "finalization",
        nodes: [{ id: "effect", kind: "command", command: { program: "tool", args: [] } }],
      },
      {},
      { workspace: { kind: "managed", id: "workspace-1" }, mode: "full" },
    );
    expect((await runtime.execute(run.id)).status).toBe("succeeded");
    expect((await store.getRun(run.id))?.status).toBe("succeeded");
    expect(heartbeatsAfterCompletion).toBe(0);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
