import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { decodeBoundary, putLoopyBodySchema } from "@loopy/contract";
import { validateCompiled } from "@loopy/contract/server";
import { errorMessage } from "@loopy/core";
import { makeService } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { Effect, Schema } from "effect";
import { R2ArtifactRegistry } from "../../src/artifacts";
import { DurableSqlDriver } from "../../src/sql-driver";
import { seedLegacyPointer } from "./legacy-pointer";

const requestSchema = Schema.Struct({
  operation: Schema.Literals(["legacy", "save", "summary", "list", "service", "inspect"]),
  body: Schema.optionalKey(putLoopyBodySchema),
});

export type SummarySizeRequest = typeof requestSchema.Type;

const workspace = "summaries";

export class SummarySizeProbe {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { BUCKET: R2Bucket },
  ) {}

  async fetch(request: Request): Promise<Response> {
    const input = decodeBoundary(requestSchema)(await request.json());
    let artifactWrites = 0;
    let graphReads = 0;

    const bucket: Pick<R2Bucket, "get" | "put"> = {
      put: async (key, value, options) => {
        artifactWrites++;

        return this.env.BUCKET.put(key, value, options);
      },
      get: async (key, options) => {
        if (key.includes("/graphs/")) {
          graphReads++;
        }

        return this.env.BUCKET.get(key, options);
      },
    };

    try {
      const store = new SqlRunStore(new DurableSqlDriver(this.ctx.storage), {
        owner: { identity: { pid: null, host: "summary-size-probe" }, isAlive: () => false },
      });

      if (input.operation === "legacy") {
        const body = decodeBoundary(putLoopyBodySchema)(input.body);
        await Effect.runPromise(validateCompiled(body));
        await seedLegacyPointer({ sql: this.ctx.storage.sql, bucket, workspace }, body, {
          savedAt: new Date().toISOString(),
          generation: crypto.randomUUID(),
        });
      }

      const registry = new R2ArtifactRegistry(this.ctx.storage, bucket, workspace);

      // Listing resolves and repairs every summary the way a single read would.
      const summaryOf = (slug: string) =>
        Effect.runPromise(
          registry
            .listSummaries()
            .pipe(Effect.map((list) => list.find((item) => item.slug === slug) ?? null)),
        );

      let value;

      switch (input.operation) {
        case "legacy":
        case "inspect":
          value = {
            pointer:
              this.ctx.storage.sql
                .exec(
                  "SELECT revision,saved_at,generation,length(CAST(source AS BLOB)) AS sourceBytes FROM artifact_definitions WHERE workspace = ? AND slug = ?",
                  workspace,
                  "summary",
                )
                .toArray()[0] ?? null,
            projection:
              this.ctx.storage.sql
                .exec(
                  "SELECT generation,projection_json FROM artifact_definition_summaries WHERE workspace = ? AND slug = ?",
                  workspace,
                  "summary",
                )
                .toArray()[0] ?? null,
            pointerColumns: this.ctx.storage.sql
              .exec<{ name: string }>("PRAGMA table_info(artifact_definitions)")
              .toArray()
              .map((row) => row.name),
          };
          break;
        case "save":
          await Effect.runPromise(registry.save(decodeBoundary(putLoopyBodySchema)(input.body)));
          value = await summaryOf("summary");
          break;
        case "summary":
          value = await summaryOf("summary");
          break;
        case "list":
          value = await Effect.runPromise(registry.listSummaries());
          break;
        case "service": {
          const summary = await summaryOf("summary");

          if (!summary) {
            throw new Error("Synthetic definition is missing.");
          }

          if (!(await Effect.runPromise(store.getRun("size-run")))) {
            const at = new Date().toISOString();
            await Effect.runPromise(
              store.createRun({
                id: "size-run",
                workspace,
                slug: "summary",
                revision: summary.revision,
                input: {},
                status: "queued",
                createdAt: at,
                updatedAt: at,
              }),
            );
          }

          const service = makeService({
            store,
            registry: () => Effect.succeed(registry),
            canonicalWorkspace: () => Effect.succeed(workspace),
            secrets: {
              list: () => Effect.succeed([]),
              set: () => Effect.void,
              remove: () => Effect.void,
            },
            generateTypes: () => Effect.die(new Error("Unused synthetic operation")),
          });

          value = {
            loopies: await Effect.runPromise(service.listLoopies(workspace)),
            runs: (await Effect.runPromise(service.listRuns({ limit: 200 }))).runs,
          };
          break;
        }
      }

      return Response.json({ value, graphReads, artifactWrites });
    } catch (cause) {
      return Response.json(
        { error: errorMessage(cause), graphReads, artifactWrites },
        { status: 400 },
      );
    }
  }
}

export default { fetch: () => new Response("Use the synthetic probe binding.", { status: 404 }) };
