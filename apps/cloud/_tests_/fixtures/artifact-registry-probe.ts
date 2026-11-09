import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { CLOUD_MAX_REQUEST_BYTES, decodeBoundary, putLoopyBodySchema } from "@loopy/contract";
import { errorMessage } from "@loopy/core";
import { apiRoutes, dispatch, eventStream, makeService } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect, Schema } from "effect";
import { ARTIFACT_LIMITS, R2ArtifactRegistry } from "../../src/artifacts";
import { DurableSqlDriver } from "../../src/sql-driver";

const command = <const O extends readonly [string, ...string[]], A extends Schema.Top>(
  operations: O,
  args: A,
) => Schema.Struct({ workspace: Schema.String, operation: Schema.Literals(operations), args });

// Bundle bytes travel as base64, the same encoding the HTTP save route decodes.
const commandSchema = Schema.Union([
  command(["save", "failWrite", "httpSave"], Schema.Tuple([putLoopyBodySchema])),
  command(["race"], Schema.Array(putLoopyBodySchema)),
  command(["get", "getBundle", "revisionGraph", "serviceChecks"], Schema.Tuple([Schema.String])),
  command(["revisionSource"], Schema.Tuple([Schema.String, Schema.String])),
  command(["fillCapacity"], Schema.Tuple([Schema.Number])),
  command(["listSummaries", "listSizes", "workspace"], Schema.Tuple([])),
]);

export class RegistryProbe {
  private readonly store;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { BUCKET: R2Bucket },
  ) {
    this.store = new SqlRunStore(new DurableSqlDriver(ctx.storage), {
      owner: { identity: { pid: null, host: "fixture" }, isAlive: () => false },
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const input = decodeBoundary(commandSchema)(await request.json());

      if (input.operation === "httpSave") {
        return await this.httpSave(input.workspace, input.args[0]);
      }

      return Response.json({ value: (await this.command(input)) ?? null });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  private registry(workspace: string, bucket: Pick<R2Bucket, "get" | "put"> = this.env.BUCKET) {
    return new R2ArtifactRegistry(this.ctx.storage, bucket, workspace);
  }

  private service(workspace: string) {
    const registry = this.registry(workspace);

    return makeService({
      store: this.store,
      registry: () => Effect.succeed(registry),
      canonicalWorkspace: () => Effect.succeed(workspace),
      secrets: {
        list: () => Effect.succeed([]),
        set: () => Effect.void,
        remove: () => Effect.void,
      },
      generateTypes: () => Effect.die(new Error("unused")),
    });
  }

  private async command(input: typeof commandSchema.Type) {
    const registry = this.registry(input.workspace);

    switch (input.operation) {
      case "save":
        return Effect.runPromise(registry.save(input.args[0]));
      case "failWrite": {
        const failing = this.registry(input.workspace, {
          get: (...args) => this.env.BUCKET.get(...args),
          put: (key, ...rest) => {
            if (key.includes("/graphs/")) {
              throw new Error("R2 write unavailable");
            }

            return this.env.BUCKET.put(key, ...rest);
          },
        });

        return Effect.runPromise(failing.save(input.args[0]));
      }

      case "race":
        return Promise.all(
          input.args.map((body) =>
            Effect.runPromise(registry.save(body)).then(() => "saved", errorMessage),
          ),
        );
      case "get":
        return Effect.runPromise(registry.get(input.args[0]));
      case "getBundle":
        return Effect.runPromise(registry.getBundle(input.args[0]));
      case "revisionGraph":
        return Effect.runPromise(registry.revisionGraph(input.args[0]));
      case "revisionSource":
        return Effect.runPromise(registry.revisionSource(...input.args));
      case "listSummaries":
        return Effect.runPromise(registry.listSummaries());
      case "workspace":
        return Effect.runPromise(registry.workspace());
      case "listSizes": {
        const entries = await Effect.runPromise(registry.listSummaries());

        const { bytes } = this.ctx.storage.sql
          .exec<{ bytes: number }>(
            "SELECT sum(s.bytes) AS bytes FROM artifact_definitions d JOIN artifact_graph_sizes s ON s.workspace = d.workspace AND s.revision = d.revision WHERE d.workspace = ?",
            input.workspace,
          )
          .one();

        return { count: entries.length, bounded: bytes <= ARTIFACT_LIMITS.listBytes };
      }

      case "fillCapacity":
        this.ctx.storage.transactionSync(() => {
          for (let index = 0; index < input.args[0]; index++) {
            this.ctx.storage.sql.exec(
              "INSERT INTO artifact_definitions (workspace, slug, revision, source, saved_at, generation) VALUES (?, ?, ?, ?, ?, ?)",
              input.workspace,
              `seed-${index}`,
              "a".repeat(64),
              "/seed.ts",
              "now",
              "seed",
            );
          }
        });

        return null;
      case "serviceChecks":
        return this.serviceChecks(input.workspace, input.args[0]);
    }
  }

  private async serviceChecks(workspace: string, slug: string) {
    const store = this.store;
    const service = this.service(workspace);
    const before = await Effect.runPromise(store.eventCursor());
    const run = await Effect.runPromise(service.startRun(slug, {}, workspace));
    const snapshot = await Effect.runPromise(service.runSnapshot(run.id));

    const schedule = await Effect.runPromise(
      service.putSchedule(slug, { cron: "* * * * *" }, workspace),
    );

    await Effect.runPromise(service.setScheduleEnabled(slug, false, workspace));
    const aborter = new AbortController();

    const response = await Effect.runPromise(
      eventStream(store, service, { after: before.cursor, epoch: before.epoch }, aborter.signal),
    );

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("The event stream has no body.");
    }

    await reader.read();
    const frame = new TextDecoder().decode((await reader.read()).value);
    aborter.abort();

    return {
      slug: run.slug,
      revision: (await Effect.runPromise(store.getRun(run.id)))?.revision,
      snapshotRead: snapshot.run.id === run.id,
      scheduled: schedule.slug,
      enabled: (await Effect.runPromise(service.listSchedules(workspace)))[0]?.enabled,
      eventDelivered: frame.includes(run.id) && frame.includes("event: txn"),
    };
  }

  private httpSave(workspace: string, body: typeof putLoopyBodySchema.Type) {
    const url = new URL(`http://127.0.0.1/api/loopies/${body.graph.name}`);

    const request = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Schema.encodeSync(putLoopyBodySchema)(body)),
    });

    return dispatch(
      apiRoutes({
        service: this.service(workspace),
        store: this.store,
        cwd: workspace,
        daemon: { pid: null, startedAt: new Date().toISOString(), concurrency: 1 },
        maxBodyBytes: CLOUD_MAX_REQUEST_BYTES,
      }),
      request,
      url,
    );
  }
}

export default {
  fetch: () => new Response("Probe requires its Durable Object binding.", { status: 404 }),
};
