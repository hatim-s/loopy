import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, TraceEvent, WorkflowDefinition } from "@loopy/contracts";
import { RuntimeScheduler } from "@loopy/runtime";
import { Storage } from "../../storage/src/index.ts";
import { InMemoryRuntimeStore } from "../../testing/src/index.ts";
import { extractImportedSession } from "../src/index.ts";

function events(name: string): TraceEvent[] {
  return JSON.parse(readFileSync(`fixtures/sessions/${name}.json`, "utf8")) as TraceEvent[];
}

function imported(name: string) {
  const suffix =
    {
      successful: "000000000001",
      "failed-then-recovered": "000000000002",
      "subagent-heavy": "000000000003",
    }[name] ?? "000000000099";
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    provider: "codex",
    session: events(name),
  };
}

describe("Phase 3 deterministic extraction integration", () => {
  test("imports, extracts, reviews, approves, and executes a successful fixture offline", async () => {
    const source = imported("successful");
    const extraction = await extractImportedSession(source);
    expect(extraction.result.ok).toBe(true);
    if (!extraction.result.ok) return;
    expect(extraction.audit.deterministic).toBe(true);
    expect(extraction.audit.attempts).toBe(1);

    const storage = new Storage({ projectDir: mkdtempSync(join(tmpdir(), "loopy-phase3-")) });
    const session = storage.runtime.createImportedSession({
      id: source.id,
      provider: source.provider,
      source: "fixture/sessions/successful.json",
      session: source.session as unknown as TraceEvent[],
    });
    const job = storage.runtime.createExtractionJob({ importId: session.id });
    storage.runtime.saveExtractionResult(job.id, {
      proposal: extraction.result.proposal,
      audit: extraction.audit as unknown as JsonValue,
    });
    const review = storage.runtime.getExtractionReview(job.id);
    expect(review?.audit).toBeDefined();
    const version = storage.runtime.approveExtractionProposal(job.id);
    expect(version.version).toBe(1);
    storage.close();

    const runtime = new RuntimeScheduler({
      store: new InMemoryRuntimeStore(),
      provider: { execute: async () => ({ status: "succeeded", outputs: { fake: true } }) },
    });
    const run = await runtime.run(version.definition as WorkflowDefinition);
    expect(run.run.status).toBe("succeeded");
    expect(run.attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(2);
  });

  test("keeps failed/recovered and subagent-heavy evidence in the audit", async () => {
    const recovered = await extractImportedSession(imported("failed-then-recovered"), {
      failFirstWith: { malformed: true },
      maxAttempts: 2,
    });
    expect(recovered.result.ok).toBe(true);
    expect(recovered.result.attempts).toBe(2);
    expect(recovered.segmentation.failures[0]?.resolved).toBe(true);
    expect(recovered.audit.segmentCounts.recoveries).toBe(1);

    const subagents = await extractImportedSession(imported("subagent-heavy"));
    expect(subagents.result.ok).toBe(true);
    expect(subagents.segmentation.causality.some((group) => group.subagent)).toBe(true);
    expect(subagents.audit.evidenceIds.length).toBeGreaterThan(0);
  });

  test("rejects unknown evidence and records bounded repair exhaustion", async () => {
    const source = imported("successful");
    const extracted = await extractImportedSession(source, {
      failFirstWith: {
        schemaVersion: "1",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        importId: source.id,
        createdAt: "2026-08-17T00:00:00.000Z",
        workflow: {},
        nodeEvidence: [],
        verifierRequirements: [],
        proposedPolicies: { evidenceIds: [] },
      },
      maxAttempts: 1,
    });
    expect(extracted.result.ok).toBe(false);
    if (!extracted.result.ok) {
      expect(extracted.result.attempts).toBe(1);
      expect(extracted.result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});
