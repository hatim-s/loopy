import {
  jsonSchema,
  logRecordSchema,
  nodeRunSchema,
  type RunRecord,
  runtimeEventSchema,
  type Schedule,
  waitRecordSchema,
} from "@loopy/core";
import { Schema } from "effect";
import { StoredDataError } from "../operation";
import { storedDecoder, storedValueDecoder } from "../row-codec";

export type RunRow = {
  id: string;
  slug: string;
  revision: string;
  workspace: string;
  input_json: string;
  status: RunRecord["status"];
  output_json: string | null;
  error: string | null;
  wake_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  owner_token: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: string | null;
};

export type ScheduleRow = {
  version: number;
  workspace: string;
  slug: string;
  cron: string;
  tz: string;
  input_json: string;
  enabled: number;
  last_fire_key: string | null;
  next_fire_at: string;
};

export type EventRow = {
  sequence: number;
  at: string;
  txn: string;
  entity: string;
  kind: string;
  run_id: string | null;
  record: string;
};

const decodeJson = storedDecoder(jsonSchema, "runs/schedules JSON");

export const decodeLog = storedDecoder(logRecordSchema, "logs");

export const decodeNodeRun = storedDecoder(nodeRunSchema, "node_runs/node_attempts");

export const decodeWait = storedDecoder(waitRecordSchema, "waits");

function outcome(row: RunRow) {
  switch (row.status) {
    case "succeeded": {
      if (row.output_json === null) {
        throw new StoredDataError(
          `Run '${row.id}' succeeded without output. Restore valid storage.`,
        );
      }

      return { status: row.status, output: decodeJson(row.output_json) };
    }

    case "failed": {
      if (row.error === null) {
        throw new StoredDataError(
          `Run '${row.id}' failed without an error. Restore valid storage.`,
        );
      }

      return { status: row.status, error: row.error };
    }

    case "suspended":
      return { status: row.status, wakeAt: row.wake_at };
    default:
      return { status: row.status };
  }
}

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    revision: row.revision,
    workspace: row.workspace,
    input: decodeJson(row.input_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...outcome(row),
  };

  if (row.next_retry_at !== null) {
    run.nextRetryAt = row.next_retry_at;
  }

  if (row.owner_token !== null && row.owner_host !== null && row.heartbeat_at !== null) {
    run.owner = {
      token: row.owner_token,
      pid: row.owner_pid,
      host: row.owner_host,
      heartbeatAt: row.heartbeat_at,
    };
  }

  return run;
}

export function rowToSchedule(row: ScheduleRow): Schedule {
  const schedule: Schedule = {
    version: row.version,
    workspace: row.workspace,
    slug: row.slug,
    cron: row.cron,
    tz: row.tz,
    input: decodeJson(row.input_json),
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
  };

  if (row.last_fire_key !== null) {
    schedule.lastFireKey = row.last_fire_key;
  }

  return schedule;
}

const decodeEvent = storedValueDecoder(runtimeEventSchema, "events");

const decodeEventRecord = storedDecoder(Schema.Unknown, "events");

export function rowToEvent(row: EventRow) {
  return decodeEvent({
    entity: row.entity,
    kind: row.kind,
    record: decodeEventRecord(row.record),
    sequence: row.sequence,
    at: row.at,
    txn: row.txn,
    runId: row.run_id,
  });
}
