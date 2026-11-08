import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, encodeBoundary } from "@loopy/contract";
import { errnoCode } from "@loopy/core";
import { Schema } from "effect";
import { readJsonLines } from "../shared/jsonl";
import { atomic } from "./files";

// The driver's on-disk protocol: admission records, progress files, event logs, the load gate,
// cohort summaries and the ABORT marker. Every reader and writer goes through this module.

export const groups = ["a", "b", "c"] as const;

export const phases = ["preflight", "primary"] as const;

export const groupSchema = Schema.Literals(groups);

export type Group = (typeof groups)[number];

export type Phase = (typeof phases)[number];

const phaseSchema = Schema.Literals(phases);

const expectedSchema = Schema.Literals(["succeeded", "failed"]);

const inputSchema = Schema.Struct({
  batch: Schema.String,
  ordinal: Schema.Int,
  fail: Schema.Boolean,
  items: Schema.Array(Schema.Number),
});

const admissionFields = {
  slug: Schema.String,
  group: groupSchema,
  phase: phaseSchema,
  input: inputSchema,
  expected: expectedSchema,
  intentAt: Schema.String,
  admittedAt: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
};

export const admissionSchema = Schema.Struct(admissionFields);

export type Admission = typeof admissionSchema.Type;

const waitSchema = Schema.Struct({
  hook: Schema.String,
  observedAt: Schema.String,
  dueAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.String),
});

export type Wait = typeof waitSchema.Type;

const artifactRecordSchema = Schema.Struct({
  expectedPath: Schema.String,
  destination: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
});

const classificationSchema = Schema.Literals(["success", "controlled-failure"]);

export const resultSchema = Schema.Struct({
  runId: Schema.String,
  slug: Schema.String,
  expected: expectedSchema,
  actual: expectedSchema,
  classification: classificationSchema,
  wait: Schema.NullOr(waitSchema),
  artifact: Schema.NullOr(artifactRecordSchema),
});

export const progressSchema = Schema.Struct({
  wait: Schema.NullOr(waitSchema),
  approvalIntentAt: Schema.NullOr(Schema.String),
  result: Schema.NullOr(resultSchema),
});

export type Progress = typeof progressSchema.Type;

const at = Schema.String;

const step = { at, runId: Schema.String, phase: phaseSchema };

export const journalEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("admitted"), at, ...admissionFields }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    ...step,
    slug: Schema.String,
    expected: expectedSchema,
    actual: Schema.Literals(["succeeded", "failed", "cancelled"]),
    unexpected: Schema.Boolean,
    classification: Schema.NullOr(classificationSchema),
    error: Schema.NullOr(Schema.String),
    wait: Schema.NullOr(waitSchema),
    intentAt: Schema.String,
    admittedAt: Schema.NullOr(Schema.String),
    terminalAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    ...step,
    artifact: Schema.NullOr(artifactRecordSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("wait-observed"),
    ...step,
    ...waitSchema.fields,
    delayMs: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("approval-intent"), ...step, hook: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("approval-reconciled"),
    ...step,
    resolvedAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("approval-resolved"),
    ...step,
    observedAt: Schema.String,
    delayMs: Schema.Number,
    resolvedAt: Schema.String,
  }),
]);

export type JournalEvent = typeof journalEventSchema.Type;

type EventInput = JournalEvent extends infer E
  ? E extends unknown
    ? Omit<E, "at">
    : never
  : never;

const encodeJournalEvent = encodeBoundary(journalEventSchema);

export const journalDirectory = (state: string) => resolve(state, "journal");

export const eventsPath = (state: string, group: Group) =>
  resolve(journalDirectory(state), `${group}.jsonl`);

export function readEvents(state: string, group: Group, mode: "strict" | "tolerant") {
  return readJsonLines(eventsPath(state, group), journalEventSchema, mode);
}

export async function admissionPath(
  state: string,
  key: { phase: Phase; group: Group; slug: string; ordinal: number },
) {
  const directory = resolve(journalDirectory(state), key.phase, key.group);
  await mkdir(directory, { recursive: true });

  return resolve(directory, `${key.slug}-${key.ordinal}.json`);
}

export const progressPath = (admissionFile: string) => `${admissionFile}.progress.json`;

export async function readAdmission(path: string) {
  return decodeBoundary(admissionSchema)(await Bun.file(path).json());
}

export async function readAdmissions(journal: string, phase?: Phase) {
  const admissions: Admission[] = [];

  for await (const path of new Bun.Glob(`${phase ?? "*"}/*/*.json`).scan({
    cwd: journal,
    absolute: true,
  })) {
    if (!path.endsWith(".progress.json")) {
      admissions.push(await readAdmission(path));
    }
  }

  return admissions;
}

export async function recordAdmission(path: string, value: Admission) {
  atomic(path, encodeBoundary(admissionSchema)(value));
}

export async function event(state: string, group: Group, value: EventInput) {
  const line = encodeJournalEvent({ at: new Date().toISOString(), ...value });
  await mkdir(journalDirectory(state), { recursive: true });
  await appendFile(eventsPath(state, group), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export const abortPath = (state: string) => resolve(state, "ABORT");

// The first reason wins; later failures are consequences and must not overwrite it.
export async function writeAbort(state: string, reason: string) {
  try {
    await writeFile(abortPath(state), `${reason}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (errnoCode(cause) !== "EEXIST") {
      throw cause;
    }
  }
}

export const gatePath = (state: string) => resolve(state, "load-enabled.json");

export const gateSchema = Schema.Struct({
  batch: Schema.String,
  baseline: Schema.String,
  enabledAt: Schema.String,
});

export const summaryPath = (evidence: string, phase: Phase, group: Group) =>
  resolve(evidence, `playground-driver-${phase}-${group}.json`);

export const summarySchema = Schema.Struct({
  status: Schema.Literals(["passed", "failed"]),
  scope: Schema.Literal("local-wrangler-docker"),
  batch: Schema.String,
  group: groupSchema,
  phase: phaseSchema,
  startedAt: Schema.String,
  endedAt: Schema.String,
  planned: Schema.Int,
  completed: Schema.Int,
  results: Schema.Array(resultSchema),
});

export async function readSummary(path: string) {
  return decodeBoundary(summarySchema)(await Bun.file(path).json());
}
