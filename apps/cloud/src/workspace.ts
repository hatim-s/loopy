import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  apiRoutes,
  dispatch,
  errorResponse,
  json,
  LoopyService,
  ServiceError,
} from "../../../packages/loopy/src/service/index.js";
import { SqlRunStore } from "../../../packages/loopy/src/store/portable.js";
import { artifactResponse } from "./artifact-route.js";
import { R2ArtifactRegistry } from "./artifacts.js";
import { concurrency, type Environment } from "./environment.js";
import { SandboxProvider } from "./provider.js";
import { WorkspaceScheduler } from "./scheduler.js";
import { DurableSqlDriver } from "./sql-driver.js";

function unsupported(): never {
  throw new ServiceError(
    "not_yet",
    "Cloud phase 1 does not store secrets or generate command types. Compile safe fixtures locally.",
  );
}

export class Workspace {
  private readonly store: SqlRunStore;
  private readonly token = crypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private scheduler?: WorkspaceScheduler;
  private provider?: SandboxProvider;
  private routes?: ReturnType<typeof apiRoutes>;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Environment,
  ) {
    this.store = new SqlRunStore(new DurableSqlDriver(ctx.storage), {
      owner: {
        identity: { pid: null, host: `durable-object:${this.token}` },
        isAlive: () => false,
      },
      leaseMs: 10_000,
    });

    const workspace = ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key='workspace'")
      .toArray()[0]?.value;

    if (workspace !== undefined) {
      this.initialize(workspace);
    }
  }

  private initialize(workspace: string): void {
    const registry = new R2ArtifactRegistry(this.ctx.storage, this.env.ARTIFACTS, workspace);

    const requireWorkspace = (value: string) => {
      if (value !== "" && value !== workspace) {
        throw new ServiceError("forbidden", "This credential belongs to a different workspace.");
      }

      return workspace;
    };

    const service = new LoopyService({
      store: this.store,
      clock: { now: Date.now },
      canonicalWorkspace: requireWorkspace,
      registry: (value) => {
        requireWorkspace(value);

        return registry;
      },
      secrets: { list: unsupported, set: unsupported, remove: unsupported },
      generateTypes: unsupported,
    });

    this.routes = apiRoutes({
      service,
      store: this.store,
      cwd: workspace,
      daemon: { pid: null, startedAt: this.startedAt, concurrency: concurrency(this.env) },
    });
    this.provider = new SandboxProvider({
      url: this.env.SANDBOX_URL,
      token: this.env.SANDBOX_TOKEN,
      workspace,
      artifacts: registry,
    });
    this.scheduler = new WorkspaceScheduler({
      storage: this.ctx.storage,
      store: this.store,
      registry,
      provider: this.provider,
      token: this.token,
      concurrency: concurrency(this.env),
      workspace,
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(work);
    this.serial = pending.then(
      () => undefined,
      () => undefined,
    );

    return pending;
  }

  fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      const workspace = request.headers.get("X-Loopy-Workspace");

      if (!workspace || !/^[a-z][a-z0-9-]{0,62}$/.test(workspace)) {
        return errorResponse("forbidden");
      }

      const row = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key='workspace'")
        .toArray()[0];

      if (row && row.value !== workspace) {
        return errorResponse("forbidden");
      }

      if (!row) {
        this.ctx.storage.sql.exec("INSERT INTO meta(key,value) VALUES ('workspace',?)", workspace);
        this.initialize(workspace);
      }

      if (!this.routes || !this.scheduler || !this.provider) {
        throw new Error("Workspace initialization did not complete.");
      }

      const url = new URL(request.url);

      if (url.searchParams.has("workspace") && url.searchParams.get("workspace") !== workspace) {
        return errorResponse("forbidden");
      }

      if (url.pathname === "/api/cloud/status") {
        return json({
          stage: "local",
          workspace,
          alarm: await this.ctx.storage.getAlarm(),
          errors: this.ctx.storage.sql
            .exec("SELECT run_id,error FROM cloud_turns WHERE error IS NOT NULL LIMIT 20")
            .toArray(),
          schedulerError:
            this.ctx.storage.sql
              .exec<{ value: string }>("SELECT value FROM meta WHERE key='cloud_scheduler_error'")
              .toArray()[0]?.value ?? null,
        });
      }

      if (!["GET", "HEAD"].includes(request.method)) {
        await this.scheduler.wake();
      }

      try {
        if (request.method === "GET" && url.pathname === "/api/cloud/artifacts") {
          return await artifactResponse({
            url,
            workspace,
            store: this.store,
            provider: this.provider,
          });
        }

        return await dispatch(this.routes, request, url);
      } catch (cause) {
        if (cause instanceof ServiceError) {
          return errorResponse(cause.code, cause.message);
        }

        return errorResponse("internal");
      }
    });
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => {
      await this.scheduler?.tick();
    });
  }
}
