import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { decodeBoundary, putLoopyBodySchema } from "@loopy/contract";
import { canonicalJson, errorMessage } from "@loopy/core";
import { makeService } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect, Schema } from "effect";
import { R2ArtifactRegistry } from "../../src/artifacts";
import { DurableSqlDriver } from "../../src/sql-driver";

const requestSchema = Schema.Struct({
  operation: Schema.Literals([
    "legacy",
    "summary",
    "list",
    "get",
    "save",
    "forget",
    "pointer",
    "race",
    "rollback",
    "service",
    "start",
    "schedule",
    "corruptSummary",
  ]),
  body: Schema.optionalKey(putLoopyBodySchema),
  slug: Schema.optionalKey(Schema.String),
});

export type SummaryProbeRequest = typeof requestSchema.Type;

const workspace = "summaries";

export class SummaryProbe {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { BUCKET: R2Bucket },
  ) {}

  async fetch(request: Request): Promise<Response> {
    const decoded = decodeBoundary(requestSchema)(await request.json());
    const input = { ...decoded, slug: decoded.slug ?? "summary" };
    let graphReads = 0;
    let transactions = 0;
    let raced = false;
    const body = () => decodeBoundary(putLoopyBodySchema)(input.body);

    const bucket: Pick<R2Bucket, "get" | "put"> = {
      put: this.env.BUCKET.put.bind(this.env.BUCKET),
      get: async (key, options) => {
        if (transactions > 0) {
          throw new Error("R2 read inside SQL transaction");
        }

        if (key.includes("/graphs/")) {
          graphReads++;
        }

        const object = await this.env.BUCKET.get(key, options);

        if (input.operation === "race" && !raced && key.includes("/graphs/")) {
          raced = true;
          await Effect.runPromise(
            new R2ArtifactRegistry(this.ctx.storage, this.env.BUCKET, workspace).save(body()),
          );
        }

        return object;
      },
    };

    const storage = {
      sql: this.ctx.storage.sql,
      transactionSync: <T>(callback: () => T): T => {
        transactions++;

        try {
          return this.ctx.storage.transactionSync(callback);
        } finally {
          transactions--;
        }
      },
    };

    try {
      const store = new SqlRunStore(new DurableSqlDriver(this.ctx.storage), {
        owner: { identity: { pid: null, host: "summary-probe" }, isAlive: () => false },
      });

      if (input.operation === "legacy") {
        storage.sql.exec(`CREATE TABLE artifact_definitions (
          workspace TEXT NOT NULL, slug TEXT NOT NULL, revision TEXT NOT NULL,
          source TEXT NOT NULL, saved_at TEXT NOT NULL, generation TEXT NOT NULL,
          PRIMARY KEY (workspace, slug)
        )`);
        const saved = body();
        await this.env.BUCKET.put(
          `workspaces/${workspace}/graphs/${saved.revision}.json`,
          canonicalJson(saved.graph),
        );
        storage.sql.exec(
          "INSERT INTO artifact_definitions VALUES (?, ?, ?, ?, ?, ?)",
          workspace,
          saved.graph.name,
          saved.revision,
          saved.source.path,
          "legacy-saved-at",
          "legacy-generation",
        );
      }

      const registry = new R2ArtifactRegistry(storage, bucket, workspace);

      const pointer = () =>
        storage.sql
          .exec(
            `SELECT d.*, s.projection_json FROM artifact_definitions d
             LEFT JOIN artifact_definition_summaries s
             ON s.workspace = d.workspace AND s.slug = d.slug AND s.generation = d.generation
             WHERE d.workspace = ? AND d.slug = ?`,
            workspace,
            input.slug,
          )
          .toArray()[0] ?? null;

      let value;

      switch (input.operation) {
        case "legacy":
          value = {
            columns: storage.sql.exec("PRAGMA table_info(artifact_definitions)").toArray(),
            projectionColumns: storage.sql
              .exec("PRAGMA table_info(artifact_definition_summaries)")
              .toArray(),
            pointer: pointer(),
          };
          break;
        case "summary":
        case "race":
          value = await Effect.runPromise(registry.summary(input.slug));
          break;
        case "list":
          value = await Effect.runPromise(registry.listSummaries());
          break;
        case "get":
          value = await Effect.runPromise(registry.get(input.slug));
          break;
        case "save":
          await Effect.runPromise(registry.save(body()));
          value = pointer();
          break;
        case "forget":
          storage.sql.exec(
            "DELETE FROM artifact_definition_summaries WHERE workspace = ? AND slug = ?",
            workspace,
            input.slug,
          );
          value = pointer();
          break;
        case "pointer":
          value = pointer();
          break;
        case "corruptSummary":
          storage.sql.exec(
            "UPDATE artifact_definition_summaries SET projection_json = '{}' WHERE workspace = ? AND slug = ?",
            workspace,
            input.slug,
          );
          value = pointer();
          break;
        case "rollback": {
          // A SQL constraint failure after the real pointer write must roll back its summary too.
          const before = pointer();
          storage.sql.exec("CREATE TABLE rollback_guard (id INTEGER PRIMARY KEY CHECK(id = 1))");

          const failing = {
            sql: storage.sql,
            transactionSync: <T>(callback: () => T): T =>
              storage.transactionSync(() => {
                const result = callback();
                storage.sql.exec("INSERT INTO rollback_guard VALUES (2)");

                return result;
              }),
          };

          let error: string | null = null;

          try {
            await Effect.runPromise(
              new R2ArtifactRegistry(failing, bucket, workspace).save(body()),
            );
          } catch (cause) {
            error = errorMessage(cause);
          }

          value = { before, after: pointer(), error };
          break;
        }

        case "service":
        case "start":
        case "schedule": {
          const service = makeService({
            store,
            registry: () => Effect.succeed(registry),
            clock: { now: Date.now },
            canonicalWorkspace: () => Effect.succeed(workspace),
            secrets: {
              list: () => Effect.succeed([]),
              set: () => Effect.void,
              remove: () => Effect.void,
            },
            generateTypes: () => Effect.die(new Error("Unused synthetic operation")),
          });

          if (input.operation === "start") {
            value = await Effect.runPromise(service.startRun(input.slug, {}, workspace));
          } else if (input.operation === "schedule") {
            value = await Effect.runPromise(
              service.putSchedule(input.slug, { cron: "* * * * *" }, workspace),
            );
          } else {
            value = {
              loopies: await Effect.runPromise(service.listLoopies(workspace)),
              runs: await Effect.runPromise(service.listRuns({ limit: 200 })),
            };
          }

          break;
        }
      }

      return Response.json({ value, graphReads });
    } catch (cause) {
      return Response.json(
        {
          error: errorMessage(cause),
          code: cause instanceof Error && "code" in cause ? cause.code : null,
          graphReads,
        },
        { status: 400 },
      );
    }
  }
}

export default { fetch: () => new Response("Use the synthetic probe binding.", { status: 404 }) };
