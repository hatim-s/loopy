import type { DurableObjectState, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import { R2ArtifactRegistry } from "../../../../apps/cloud/src/artifacts.js";
import { DurableSqlDriver } from "../../../../apps/cloud/src/sql-driver.js";
import { putLoopyBodySchema, validateCompiled } from "../../src/contract/index.js";
import { canonicalJson, errorMessage } from "../../src/core/index.js";
import { LoopyService } from "../../src/service/index.js";
import { SqlRunStore } from "../../src/store/portable.js";

const requestSchema = z.object({
  operation: z.enum(["legacy", "save", "summary", "list", "service", "inspect"]),
  body: putLoopyBodySchema.optional(),
});

export type SummarySizeRequest = z.input<typeof requestSchema>;

const workspace = "summaries";

export class SummarySizeProbe {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { BUCKET: R2Bucket },
  ) {}

  async fetch(request: Request): Promise<Response> {
    const input = requestSchema.parse(await request.json());
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
        const body = putLoopyBodySchema.parse(input.body);
        await validateCompiled(body);
        this.ctx.storage.sql.exec(`CREATE TABLE artifact_definitions (
          workspace TEXT NOT NULL, slug TEXT NOT NULL, revision TEXT NOT NULL,
          source TEXT NOT NULL, saved_at TEXT NOT NULL, generation TEXT NOT NULL,
          PRIMARY KEY (workspace, slug)
        )`);
        await bucket.put(
          `workspaces/${workspace}/graphs/${body.revision}.json`,
          canonicalJson(body.graph),
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO artifact_definitions VALUES (?, ?, ?, ?, ?, ?)",
          workspace,
          body.graph.name,
          body.revision,
          body.source.path,
          new Date().toISOString(),
          crypto.randomUUID(),
        );
      }

      const registry = new R2ArtifactRegistry(this.ctx.storage, bucket, workspace);
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
          await registry.save(putLoopyBodySchema.parse(input.body));
          value = await registry.summary("summary");
          break;
        case "summary":
          value = await registry.summary("summary");
          break;
        case "list":
          value = await registry.listSummaries();
          break;
        case "service": {
          const summary = await registry.summary("summary");

          if (!summary) {
            throw new Error("Synthetic definition is missing.");
          }

          if (!(await store.getRun("size-run"))) {
            const at = new Date().toISOString();
            await store.createRun({
              id: "size-run",
              workspace,
              slug: "summary",
              revision: summary.revision,
              input: {},
              status: "queued",
              createdAt: at,
              updatedAt: at,
            });
          }

          const service = new LoopyService({
            store,
            registry: () => registry,
            clock: { now: Date.now },
            canonicalWorkspace: () => workspace,
            secrets: { list: () => [], set: () => {}, remove: () => {} },
            generateTypes: async () => {
              throw new Error("Unused synthetic operation.");
            },
          });

          value = {
            loopies: await service.listLoopies(workspace),
            runs: await service.listRuns({ limit: 200 }),
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
