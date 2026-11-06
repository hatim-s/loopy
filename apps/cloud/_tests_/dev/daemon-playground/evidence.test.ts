import { expect, test } from "bun:test";
import { decodeBoundary, runStatusSchema } from "@loopy/contract";
import { Schema } from "effect";
import { backupSchema } from "../../../dev/daemon-playground/backup-schema";
import { preflightSchema, reportSchema } from "../../../dev/daemon-playground/report-schema";

const at = "2026-11-05T00:00:00.000Z";

const record = {
  slug: "fixture",
  input: { batch: "fixture", ordinal: 1, fail: false, items: [] },
  run: {
    id: "fixture-run",
    slug: "fixture",
    workspace: "/fixture",
    loopy: { slug: "fixture", description: null },
    input: {},
    createdAt: at,
    updatedAt: at,
    status: "succeeded",
    output: {},
    owner: null,
    ownerStale: false,
  },
  nodeRuns: [],
  receipts: [
    {
      path: "fixture.json",
      sha256: "a".repeat(64),
      kind: "finished",
      attempt: 1,
      key: { runId: "fixture-run", nodeId: "0:code", scope: [] },
    },
  ],
  outputs: [],
  outputDirectory: "/fixture/output",
  observedMs: 1,
  admissionMs: 1,
  firstNodeStartedAt: null,
  hold: { heldMs: 1, approved: true, observedAt: at, resolvedAt: at },
  matched: true,
  admittedAt: at,
  artifactIdentity: null,
  attemptCount: 1,
  hooks: [],
  logs: [],
  retried: [],
  terminalAt: at,
  truncation: {},
  waitingOn: null,
};

test("retained report projections accept complete producer metadata and keep contracts strict", () => {
  const report = {
    startedAt: at,
    endedAt: at,
    completed: 45,
    matched: 45,
    records: Array.from({ length: 45 }, () => record),
    restartProof: { runId: "fixture-run", before: [], after: [], afterNodes: [], claimFencing: {} },
    apiRuns: [],
    cleanup: {},
    failure: null,
    limits: {},
    starts: [],
  };

  const decoded = Schema.decodeUnknownSync(reportSchema)(report);
  expect(decoded.records).toHaveLength(45);
  expect(decoded.records[0]?.run.waitingOn).toBeNull();
  expect(
    Schema.decodeUnknownSync(preflightSchema)({
      revisions: [{ slug: "fixture", revision: "r", nodeCount: 1 }],
      concurrency: 4,
      frozenAt: at,
      mode: "fixture",
    }).revisions,
  ).toHaveLength(1);
  expect(() =>
    Schema.decodeUnknownSync(reportSchema)({
      ...report,
      records: Array.from({ length: 45 }, () => ({
        ...record,
        run: { ...record.run, unexpected: true },
      })),
    }),
  ).toThrow();
});

test("diagnostic backup decodes nonempty source and copied rows for all statuses", () => {
  const rows = runStatusSchema.literals.map((status, id) => ({ id: String(id), status }));

  const backup = decodeBoundary(backupSchema)({
    method: "sqlite3_backup",
    source: "/fixture/source",
    destination: "/fixture/copy",
    destinationJournal: "delete",
    sidecarsBefore: [{ suffix: "-wal", bytes: 1 }],
    sidecarsAfter: [],
    sourceRows: rows,
    copiedRows: rows,
    integrity: "ok",
    matchesSource: true,
    matchesApi: true,
    matches45ApiRuns: false,
  });

  expect(backup.sourceRows).toEqual(rows);
  expect(backup.copiedRows).toEqual(rows);
});
