import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { logRecordSchema, nodeRunSchema } from "../../packages/loopy/src/contract/index.ts";
import { state, writeEvidence } from "./config.ts";

const rowsSchema = z.array(z.object({ record: z.string() }));

export async function closedExecutions() {
  const path = join(state, "daemon-readonly.sqlite");
  const database = new Database(path, { readonly: true });

  try {
    const nodes = rowsSchema
      .parse(database.query("SELECT record FROM node_runs ORDER BY run_id,execution_key").all())
      .map((row) => nodeRunSchema.parse(JSON.parse(row.record)));

    const attempts = rowsSchema
      .parse(
        database
          .query("SELECT record FROM node_attempts ORDER BY run_id,execution_key,attempt")
          .all(),
      )
      .map((row) => nodeRunSchema.parse(JSON.parse(row.record)));

    const logs = rowsSchema
      .parse(database.query("SELECT record FROM logs ORDER BY run_id,seq").all())
      .map((row) => logRecordSchema.parse(JSON.parse(row.record)));

    const revisions = z
      .array(z.object({ id: z.string(), slug: z.string(), revision: z.string() }))
      .parse(database.query("SELECT id,slug,revision FROM runs ORDER BY id").all());

    const records = revisions.map((run) => ({
      ...run,
      nodes: nodes.filter((node) => node.key.runId === run.id),
      attempts: attempts.filter((node) => node.key.runId === run.id),
      logs: logs.filter((log) => log.runId === run.id),
    }));

    await writeEvidence("-executions", {
      source: path,
      access: "Bun Database readonly with SELECT only; no store constructor or migration",
      records,
    });

    return records;
  } finally {
    database.close();
  }
}
