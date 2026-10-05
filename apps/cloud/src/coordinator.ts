import { DurableRunner } from "../../../packages/loopy/src/runtime/durable-runner.js";
import { MAX_EXECUTION_OUTPUT_BYTES } from "../../../packages/loopy/src/runtime/remote-executor.js";
import { SqliteStore } from "../../../packages/loopy/src/storage/sqlite.js";
import type { CloudEnv, CoordinatorState } from "./types.js";

type Identity = { tenantId: string; runId: string };

/** Only internal namespace bindings reach this object. D1 owns execution state. */
export class RunCoordinator {
  constructor(
    private readonly state: CoordinatorState,
    private readonly env: CloudEnv,
  ) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wake")
      return new Response("Not found", { status: 404 });
    const value = (await request.json()) as Partial<Identity>;
    if (
      typeof value.tenantId !== "string" ||
      !value.tenantId ||
      typeof value.runId !== "string" ||
      !value.runId
    )
      return new Response("Invalid coordinator identity", { status: 400 });
    const identity: Identity = { tenantId: value.tenantId, runId: value.runId };
    await this.state.blockConcurrencyWhile(async () => {
      const prior = await this.state.storage.get<Identity>("identity");
      if (prior && (prior.tenantId !== identity.tenantId || prior.runId !== identity.runId))
        throw new Error("Coordinator identity conflict");
      await this.state.storage.put("identity", identity);
      const existing = await this.state.storage.getAlarm();
      if (existing === null || existing > Date.now() + 100)
        await this.state.storage.setAlarm(Date.now() + 1);
    });
    return Response.json({ state: "scheduled" });
  }

  async alarm(): Promise<void> {
    const identity = await this.state.storage.get<Identity>("identity");
    if (!identity) return;
    // Rearm before external work, so a crashed invocation retains a recovery wakeup.
    await this.state.storage.setAlarm(Date.now() + 30_000);
    const store = new SqliteStore(this.env.DB, { tenantId: identity.tenantId });
    const runner = new DurableRunner({
      store,
      artifacts: store,
      stateBytes: store.limits.stateBytes,
      artifactBytes: store.limits.artifactBytes,
      executor: {
        maxOutputBytes: MAX_EXECUTION_OUTPUT_BYTES,
        start: (request) => this.env.EXECUTOR.start(request),
        inspect: (key) => this.env.EXECUTOR.inspect(key),
        cancel: (key) => this.env.EXECUTOR.cancel(key),
      },
      workspaces: {
        provision: (...args) => this.env.EXECUTOR.provisionWorkspace(...args),
        inspect: (...args) => this.env.EXECUTOR.inspectWorkspace(...args),
      },
      runtime: { build: this.env.RUNTIME_BUILD, graphSchema: 1 },
      runtimeForRun: async (runId) => {
        const runtime = await store.runtimeForRun(runId);
        if (!runtime) throw new Error("Admitted runtime not found");
        return runtime;
      },
    });
    try {
      const result = await runner.tick(identity.runId);
      await this.state.storage.put("failures", 0);
      if (
        result.state === "terminal" ||
        result.state === "idle" ||
        (result.state === "blocked" && !result.wakeAt)
      ) {
        await this.state.storage.deleteAlarm();
      } else {
        const wake = result.wakeAt ? Date.parse(result.wakeAt) : Date.now() + 1;
        await this.state.storage.setAlarm(
          Number.isFinite(wake) ? Math.max(wake, Date.now() + 1) : Date.now() + 1000,
        );
      }
    } catch {
      const failures = ((await this.state.storage.get<number>("failures")) ?? 0) + 1;
      await this.state.storage.put("failures", failures);
      await this.state.storage.setAlarm(
        Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)),
      );
    }
  }
}
