import { describe, expect, test } from "bun:test";
import workflowFixture from "../../../fixtures/workflows/valid-basic.json";
import type { DeterministicExtractionInput } from "../src/prompt.ts";
import { extractWithRepair } from "../src/repair.ts";

const importId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstEvent = "55555555-5555-4555-8555-555555555555";
const secondEvent = "66666666-6666-4666-8666-666666666666";
const evidenceOne = "77777777-7777-4777-8777-777777777777";
const evidenceTwo = "88888888-8888-4888-8888-888888888888";

const input: DeterministicExtractionInput = {
  importId,
  sourceEvents: [{ id: firstEvent }, { id: secondEvent }],
  segments: [{ id: "99999999-9999-4999-8999-999999999999", eventIds: [firstEvent] }],
  features: [{ id: "11111111-1111-4111-8111-111111111112", eventIds: [secondEvent] }],
  evidence: [
    { id: evidenceOne, eventIds: [firstEvent] },
    { id: evidenceTwo, eventIds: [secondEvent] },
  ],
};

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workflow = structuredClone(workflowFixture);
  workflow.metadata = {
    ...workflow.metadata,
    createdFrom: "extraction",
  };
  const firstNode = workflow.nodes[0];
  const secondNode = workflow.nodes[1];
  if (!firstNode || !secondNode) throw new Error("workflow fixture nodes missing");
  return {
    schemaVersion: "1",
    id: "12121212-1212-4121-8121-121212121212",
    importId,
    createdAt: "2026-08-17T00:00:00.000Z",
    workflow,
    inferredInputs: [],
    nodeEvidence: [
      {
        evidenceId: evidenceOne,
        nodeId: firstNode.id,
        eventIds: [firstEvent],
        rationale: "The implementation step is observed in the trace.",
      },
      {
        evidenceId: evidenceTwo,
        nodeId: secondNode.id,
        eventIds: [secondEvent],
        rationale: "The verification step is observed in the trace.",
      },
    ],
    removedDetours: [],
    warnings: [],
    verifierRequirements: [
      {
        check: "tests",
        command: "bun test",
        rationale: "The trace runs the test command.",
        evidenceIds: [evidenceTwo],
        required: true,
      },
    ],
    proposedPolicies: { evidenceIds: [evidenceOne] },
    expectedSideEffects: [],
    unresolvedQuestions: [],
    status: "approved",
    ...overrides,
  };
}

describe("extraction proposal compiler and repair", () => {
  test("accepts a valid proposal and compiles its workflow", async () => {
    const result = await extractWithRepair(
      input,
      { extract: () => proposal() },
      { maxAttempts: 2 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approval).toBe("approved");
      expect(result.plan.workflowId).toBe(workflowFixture.id);
      expect(result.audits).toHaveLength(1);
    }
  });

  test("repairs a schema error with diagnostics from the failed attempt", async () => {
    const seen: string[][] = [];
    let call = 0;
    const result = await extractWithRepair(input, {
      extract: (request) => {
        seen.push(request.diagnostics.map((diagnostic) => diagnostic.code));
        call += 1;
        return call === 1 ? {} : proposal();
      },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toContain("PROPOSAL_SCHEMA_INVALID");
    expect(result.audits).toHaveLength(2);
  });

  test("repairs a graph compile error", async () => {
    let call = 0;
    const result = await extractWithRepair(input, {
      extract: () => {
        call += 1;
        if (call === 1) {
          const invalid = proposal();
          (invalid.workflow as Record<string, unknown>).edges = [];
          return invalid;
        }
        return proposal();
      },
    });
    expect(result.ok).toBe(true);
    expect(result.audits[0]?.diagnostics.some((diagnostic) => diagnostic.kind === "compile")).toBe(
      true,
    );
  });

  test("rejects evidence that is not present in the source trace", async () => {
    const invalid = proposal();
    const firstNodeEvidence = (invalid.nodeEvidence as Array<Record<string, unknown>>)[0];
    if (!firstNodeEvidence) throw new Error("missing node evidence");
    firstNodeEvidence.eventIds = ["13131313-1313-4131-8131-131313131313"];
    const result = await extractWithRepair(input, { extract: () => invalid }, { maxAttempts: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("UNKNOWN_SOURCE_EVENT");
  });

  test("stops after the explicit repair bound is exhausted", async () => {
    let calls = 0;
    const result = await extractWithRepair(
      input,
      {
        extract: () => {
          calls += 1;
          return { malformed: true };
        },
      },
      { maxAttempts: 2 },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.audits).toHaveLength(2);
  });
});
