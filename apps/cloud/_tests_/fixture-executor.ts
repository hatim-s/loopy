import { WorkerEntrypoint } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import type { TenantScope } from "../../../packages/loopy/src/application/ports.js";
import {
  type ExecutionReceipt,
  type ExecutionReceiptStore,
  RemoteLinuxExecutor,
} from "../../../packages/loopy/src/cloud/executor/controller.js";
import type {
  ExecutionKey,
  ExecutionObservation,
  StartCommand,
  WorkspaceGeneration,
} from "../../../packages/loopy/src/runtime/remote-executor.js";

// Only the sandbox provider is a fixture. Coordinator, runner and controller are production classes.
export default class FixtureExecutor extends WorkerEntrypoint<{ DB: D1Database }> {
  private controller(): RemoteLinuxExecutor {
    const db = this.env.DB;
    const key = (value: ExecutionKey) =>
      JSON.stringify([value.tenantId, value.runId, value.attemptId]);
    const receipts: ExecutionReceiptStore = {
      read: async (value) => {
        const row = await db
          .prepare("SELECT payload FROM fixture_receipts WHERE id=?")
          .bind(key(value))
          .first<{ payload: string }>();
        return row ? (JSON.parse(row.payload) as ExecutionReceipt) : undefined;
      },
      compareAndSwap: async (value, revision, next) => {
        const result =
          revision === undefined
            ? await db
                .prepare(
                  "INSERT INTO fixture_receipts(id,revision,payload) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
                )
                .bind(key(value), next.revision, JSON.stringify(next))
                .run()
            : await db
                .prepare(
                  "UPDATE fixture_receipts SET revision=?,payload=? WHERE id=? AND revision=?",
                )
                .bind(next.revision, JSON.stringify(next), key(value), revision)
                .run();
        return result.meta.changes === 1;
      },
    };
    const observe = async (value: ExecutionKey): Promise<ExecutionObservation> => {
      const row = await db
        .prepare("SELECT payload FROM fixture_jobs WHERE id=?")
        .bind(key(value))
        .first<{ payload: string }>();
      return row ? (JSON.parse(row.payload) as ExecutionObservation) : { state: "not-started" };
    };
    return new RemoteLinuxExecutor(receipts, {
      workspace: async () => "available",
      start: async (request) => {
        const running = {
          state: "running" as const,
          jobId: key(request.key),
          workspace: request.workspace,
        };
        await db
          .prepare("INSERT INTO fixture_jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO NOTHING")
          .bind(key(request.key), JSON.stringify(running))
          .run();
        const row = await observe(request.key);
        if (row.state === "not-started") throw new Error("Missing fixture job");
        return row;
      },
      inspect: observe,
      cancel: async (value) => {
        const cancelled = { state: "cancelled-before-start" as const };
        await db
          .prepare(
            "INSERT INTO fixture_jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          )
          .bind(key(value), JSON.stringify(cancelled))
          .run();
        return cancelled;
      },
    });
  }
  start(request: StartCommand) {
    return this.controller().start(request);
  }
  async inspect(key: ExecutionKey) {
    await this.env.DB.prepare("UPDATE fixture_faults SET polls=polls+1 WHERE id=1").run();
    const fault = await this.env.DB.prepare("SELECT enabled FROM fixture_faults WHERE id=1").first<{
      enabled: number;
    }>();
    if (fault?.enabled) {
      await this.env.DB.prepare("UPDATE fixture_faults SET failures=failures+1 WHERE id=1").run();
      throw new Error("Fixture executor unavailable");
    }
    return this.controller().inspect(key);
  }
  cancel(key: ExecutionKey) {
    return this.controller().cancel(key);
  }
  async provisionWorkspace(
    _scope: TenantScope,
    _runId: string,
    workspaceId: string,
  ): Promise<WorkspaceGeneration> {
    return { workspaceId, generation: "fixture-generation" };
  }
  async inspectWorkspace(
    _scope: TenantScope,
    _workspace: WorkspaceGeneration,
  ): Promise<"available" | "lost"> {
    return "available";
  }
  override fetch() {
    return new Response("No public executor API", { status: 404 });
  }
}
