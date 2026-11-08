import { Database } from "bun:sqlite";
import { join } from "node:path";
import { decodeBoundary, logRecordSchema, nodeRunSchema } from "@loopy/contract";
import { Schema } from "effect";
import { state } from "./config";

export const closedDatabase = join(state, "daemon-readonly.sqlite");

const recordRows = decodeBoundary(Schema.Array(Schema.Struct({ record: Schema.String })));

const runRows = decodeBoundary(
  Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String, revision: Schema.String })),
);

function records<S extends Schema.ConstraintDecoder<unknown>>(
  database: Database,
  sql: string,
  schema: S,
) {
  const decode = decodeBoundary(schema);

  return recordRows(database.query(sql).all()).map((row) => decode(JSON.parse(row.record)));
}

export function closedExecutions() {
  const database = new Database(closedDatabase, { readonly: true });

  try {
    const nodes = records(
      database,
      "SELECT record FROM node_runs ORDER BY run_id,execution_key",
      nodeRunSchema,
    );

    const attempts = records(
      database,
      "SELECT record FROM node_attempts ORDER BY run_id,execution_key,attempt",
      nodeRunSchema,
    );

    const logs = records(database, "SELECT record FROM logs ORDER BY run_id,seq", logRecordSchema);

    return runRows(database.query("SELECT id,slug,revision FROM runs ORDER BY id").all()).map(
      (run) => ({
        ...run,
        nodes: nodes.filter((node) => node.key.runId === run.id),
        attempts: attempts.filter((node) => node.key.runId === run.id),
        logs: logs.filter((log) => log.runId === run.id),
      }),
    );
  } finally {
    database.close();
  }
}
