import type { z } from "zod";
import {
  type CursorView,
  encodeRunCursor,
  type Json,
  type RunView,
  type routes,
  runView,
  type SavedLoopy,
  serverEvent,
} from "../../contract/index.js";
import { type RunRecord, type RuntimeEvent, StoreError } from "../../core/index.js";
import { canonicalPath } from "../../executor/index.js";
import { ServiceError } from "../service-error.js";
import { ServiceContext } from "./context.js";

function missingRun(id: string) {
  return new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
}

export class RunsService extends ServiceContext {
  async startRun(slug: string, input: Json, workspace: string): Promise<RunView> {
    const { registry, saved } = this.target(slug, workspace);

    const runId = crypto.randomUUID();
    const validated = this.validateInput(saved, input);
    await this.options.store.createRun({
      id: runId,
      slug,
      input: validated,
      projectRoot: registry.project,
      runDirectory: canonicalPath(workspace),
      revision: saved.revision,
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    });

    return this.view(await this.requireRun(runId));
  }

  async requireRun(id: string): Promise<RunRecord> {
    const run = await this.options.store.getRun(id);

    if (!run) {
      throw missingRun(id);
    }

    return run;
  }

  view(run: RunRecord): RunView {
    return this.project(run, this.options.registry(run.projectRoot).get(run.slug));
  }

  project(run: RunRecord, saved: SavedLoopy | null): RunView {
    return runView({
      run,
      steps: [],
      hooks: [],
      loopy: { slug: run.slug, description: saved?.graph.meta.description ?? null },
      now: this.now(),
      leaseMs: this.options.store.leaseMs,
    });
  }

  private async claim(id: string, token: string) {
    try {
      await this.options.store.claim(id, token);
    } catch (error) {
      if (
        error instanceof StoreError &&
        (error.code === "not_found" ||
          error.code === "owned_elsewhere" ||
          error.code === "not_claimable")
      ) {
        throw new ServiceError(error.code);
      }

      throw error;
    }
  }

  async resumeRun(id: string): Promise<RunView> {
    const code = await this.options.store.wakeRun(id, this.now());

    if (code) {
      throw new ServiceError(code);
    }

    return this.view(await this.requireRun(id));
  }

  async cancelRun(id: string): Promise<RunView> {
    const token = crypto.randomUUID();
    await this.claim(id, token);

    try {
      await this.options.store.apply({
        runId: id,
        token,
        effects: [{ kind: "finish_run", outcome: { status: "cancelled" }, at: this.now() }],
      });
    } finally {
      await this.options.store.release(id, token);
    }

    return this.view(await this.requireRun(id));
  }

  resolveNamedHook: (id: string, name: string, payload: Json) => Promise<RunView> = async () => {
    throw new ServiceError("not_yet");
  };

  resolveHook: (token: string, payload: Json) => Promise<RunView> = async () => {
    throw new ServiceError("not_yet");
  };

  async runSnapshot(id: string) {
    const snapshot = await this.options.store.snapshotRun(id);

    if (!snapshot) {
      throw missingRun(id);
    }

    return {
      ...snapshot,
      run: runView({
        ...snapshot,
        loopy: this.view(snapshot.run).loopy,
        now: this.now(),
        leaseMs: this.options.store.leaseMs,
      }),
    };
  }

  async listRuns(query: z.output<typeof routes.runs.query>): Promise<RunView[]> {
    const runs = (await this.options.store.listRuns(query))
      .filter((run) => query.before === undefined || encodeRunCursor(run) < query.before)
      .sort(
        (a, b) =>
          Number(encodeRunCursor(a) < encodeRunCursor(b)) -
          Number(encodeRunCursor(a) > encodeRunCursor(b)),
      );

    const selected = query.waiting === undefined ? runs.slice(0, query.limit) : runs;

    return selected
      .map((run) => this.view(run))
      .filter((run) => query.waiting === undefined || (run.waitingOn !== null) === query.waiting)
      .slice(0, query.limit);
  }

  async events(transaction: RuntimeEvent[]) {
    return transaction.map((event) => serverEvent(event, (run) => this.view(run)));
  }

  async cursor(): Promise<CursorView> {
    return this.options.store.eventCursor();
  }
}
