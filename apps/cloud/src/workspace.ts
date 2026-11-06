import type { DurableObjectState } from "@cloudflare/workers-types";
import { Effect, Semaphore } from "effect";
import {
  apiRoutes,
  dispatch,
  errorResponse,
  GenerationError,
  json,
  makeService,
  SecretError,
  ServiceError,
} from "../../../packages/loopy/src/service";
import { SqlRunStore } from "../../../packages/loopy/src/store/portable";
import { R2ArtifactRegistry } from "./artifacts";
import { artifactResponse } from "./artifacts/route";
import { concurrency, type Environment } from "./environment";
import { platform } from "./operation";
import { SandboxProvider } from "./provider";
import { WorkspaceScheduler } from "./scheduler";
import { DurableSqlDriver } from "./sql-driver";

export class Workspace {
  private readonly store: SqlRunStore;
  private readonly token = crypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private scheduler?: WorkspaceScheduler;
  private provider?: SandboxProvider;
  private routes?: ReturnType<typeof apiRoutes>;
  private readonly serial = Semaphore.makeUnsafe(1);

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

    const requireWorkspace = (value: string) =>
      value !== "" && value !== workspace
        ? Effect.fail(
            new ServiceError("forbidden", "This credential belongs to a different workspace."),
          )
        : Effect.succeed(workspace);

    const service = makeService({
      store: this.store,
      clock: { now: Date.now },
      canonicalWorkspace: requireWorkspace,
      registry: (value) => requireWorkspace(value).pipe(Effect.as(registry)),
      secrets: {
        list: () =>
          Effect.fail(
            new SecretError({
              operation: "read",
              reason: "io",
              cause: "Cloud secrets unsupported",
            }),
          ),
        set: () =>
          Effect.fail(
            new SecretError({ operation: "set", reason: "io", cause: "Cloud secrets unsupported" }),
          ),
        remove: () =>
          Effect.fail(
            new SecretError({
              operation: "remove",
              reason: "io",
              cause: "Cloud secrets unsupported",
            }),
          ),
      },
      generateTypes: () =>
        Effect.fail(new GenerationError({ cause: "Cloud generation unsupported" })),
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

  fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      this.serial
        .withPermit(
          Effect.gen({ self: this }, function* () {
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
              this.ctx.storage.sql.exec(
                "INSERT INTO meta(key,value) VALUES ('workspace',?)",
                workspace,
              );
              this.initialize(workspace);
            }

            if (!this.routes || !this.scheduler || !this.provider) {
              return yield* Effect.die(new Error("Workspace initialization did not complete."));
            }

            const url = new URL(request.url);

            if (
              url.searchParams.has("workspace") &&
              url.searchParams.get("workspace") !== workspace
            ) {
              return errorResponse("forbidden");
            }

            if (url.pathname === "/api/cloud/status") {
              return json({
                stage: "local",
                workspace,
                alarm: yield* platform("get alarm", () => this.ctx.storage.getAlarm()),
                errors: this.ctx.storage.sql
                  .exec("SELECT run_id,error FROM cloud_turns WHERE error IS NOT NULL LIMIT 20")
                  .toArray(),
                schedulerError:
                  this.ctx.storage.sql
                    .exec<{ value: string }>(
                      "SELECT value FROM meta WHERE key='cloud_scheduler_error'",
                    )
                    .toArray()[0]?.value ?? null,
              });
            }

            if (!["GET", "HEAD"].includes(request.method)) {
              yield* this.scheduler.wake();
            }

            if (
              url.pathname === "/api/secrets" ||
              url.pathname.startsWith("/api/secrets/") ||
              url.pathname === "/api/types"
            ) {
              return errorResponse(
                "not_yet",
                "Cloud phase 1 does not store secrets or generate command types. Compile safe fixtures locally.",
              );
            }

            if (request.method === "GET" && url.pathname === "/api/cloud/artifacts") {
              return yield* artifactResponse({
                url,
                workspace,
                store: this.store,
                provider: this.provider,
              });
            }

            const routes = this.routes;

            return yield* platform("dispatch HTTP", () => dispatch(routes, request, url));
          }),
        )
        .pipe(Effect.catchCause(() => Effect.succeed(errorResponse("internal")))),
    );
  }

  alarm(): Promise<void> {
    return Effect.runPromise(
      this.serial.withPermit(Effect.suspend(() => this.scheduler?.tick() ?? Effect.void)),
    );
  }
}
