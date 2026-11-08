import type { DurableObjectState } from "@cloudflare/workers-types";
import { encodeBoundary } from "@loopy/contract";
import { cloudRoutes, cloudStatusSchema, WORKSPACE_HEADER } from "@loopy/contract/sandbox";
import {
  apiRoutes,
  dispatch,
  errorResponse,
  json,
  makeService,
  ServiceError,
} from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect, Semaphore } from "effect";
import { R2ArtifactRegistry } from "./artifacts";
import { artifactResponse } from "./artifacts/route";
import { type CloudConfig, cloudConfig, type Environment } from "./environment";
import { platform } from "./operation";
import { SandboxProvider } from "./provider";
import { SCHEDULER, WorkspaceScheduler } from "./scheduler";
import { DurableSqlDriver } from "./sql-driver";

const WORKSPACE_KEY = "workspace";

// Route paths sit under the `/api` mount that routeUrl adds.
const STATUS_PATH = `/api${cloudRoutes.status.path}`;

const ARTIFACT_PATH = `/api${cloudRoutes.artifact.path}`;

const SCHEDULER_ERROR_KEY = "cloud_scheduler_error";

const PHASE_1_UNSUPPORTED =
  "Cloud phase 1 does not store secrets or generate command types. Compile safe fixtures locally.";

const unsupported = () => Effect.fail(new ServiceError("not_yet", PHASE_1_UNSUPPORTED));

type Ready = {
  workspace: string;
  routes: ReturnType<typeof apiRoutes>;
  scheduler: WorkspaceScheduler;
  provider: SandboxProvider;
};

export class Workspace {
  private readonly store: SqlRunStore;
  private readonly config: CloudConfig;
  private readonly token = crypto.randomUUID();
  private readonly startedAt = new Date().toISOString();
  private ready: Ready | null = null;
  private readonly serial = Semaphore.makeUnsafe(1);

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Environment,
  ) {
    this.config = cloudConfig(env);
    this.store = new SqlRunStore(new DurableSqlDriver(ctx.storage), {
      owner: {
        identity: { pid: null, host: `durable-object:${this.token}` },
        isAlive: () => false,
      },
      leaseMs: SCHEDULER.leaseMs,
    });

    const workspace = ctx.storage.kv.get<string>(WORKSPACE_KEY);

    if (workspace !== undefined) {
      this.ready = this.initialize(workspace);
    }
  }

  private initialize(workspace: string): Ready {
    const registry = new R2ArtifactRegistry(this.ctx.storage, this.env.ARTIFACTS, workspace);

    const requireWorkspace = (value: string) =>
      value === workspace
        ? Effect.succeed(workspace)
        : Effect.fail(
            new ServiceError("forbidden", "This credential belongs to a different workspace."),
          );

    const service = makeService({
      store: this.store,
      clock: { now: Date.now },
      canonicalWorkspace: requireWorkspace,
      registry: (value) => requireWorkspace(value).pipe(Effect.as(registry)),
      secrets: { list: unsupported, set: unsupported, remove: unsupported },
      generateTypes: unsupported,
    });

    const provider = new SandboxProvider({
      ...this.config.sandbox,
      workspace,
      artifacts: registry,
    });

    return {
      workspace,
      provider,
      routes: apiRoutes({
        service,
        store: this.store,
        cwd: workspace,
        daemon: { pid: null, startedAt: this.startedAt, concurrency: this.config.concurrency },
      }),
      scheduler: new WorkspaceScheduler({
        storage: this.ctx.storage,
        failures: {
          read: () => this.ctx.storage.kv.get<string>(SCHEDULER_ERROR_KEY) ?? null,
          write: (error) => this.ctx.storage.kv.put(SCHEDULER_ERROR_KEY, error),
        },
        store: this.store,
        registry,
        provider,
        token: this.token,
        concurrency: this.config.concurrency,
      }),
    };
  }

  /** The Worker is the only caller and always sets the authenticated workspace header. */
  private bind(workspace: string): Ready | null {
    if (this.ready) {
      return this.ready.workspace === workspace ? this.ready : null;
    }

    this.ctx.storage.kv.put(WORKSPACE_KEY, workspace);
    this.ready = this.initialize(workspace);

    return this.ready;
  }

  fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      this.serial
        .withPermit(
          Effect.gen({ self: this }, function* () {
            const header = request.headers.get(WORKSPACE_HEADER);
            const ready = header === null ? null : this.bind(header);

            if (!ready) {
              return errorResponse("forbidden");
            }

            const { workspace, scheduler, provider, routes } = ready;
            const url = new URL(request.url);

            if (
              url.searchParams.has("workspace") &&
              url.searchParams.get("workspace") !== workspace
            ) {
              return errorResponse("forbidden");
            }

            if (url.pathname === STATUS_PATH) {
              return json(
                encodeBoundary(cloudStatusSchema)({
                  stage: "local",
                  workspace,
                  ...(yield* scheduler.status()),
                }),
              );
            }

            if (!["GET", "HEAD"].includes(request.method)) {
              yield* scheduler.wake();
            }

            if (request.method === "GET" && url.pathname === ARTIFACT_PATH) {
              return yield* artifactResponse({ url, workspace, store: this.store, provider });
            }

            return yield* platform("dispatch HTTP", () => dispatch(routes, request, url));
          }),
        )
        .pipe(Effect.catchCause(() => Effect.succeed(errorResponse("internal")))),
    );
  }

  alarm(): Promise<void> {
    return Effect.runPromise(
      this.serial.withPermit(Effect.suspend(() => this.ready?.scheduler.tick() ?? Effect.void)),
    );
  }
}
