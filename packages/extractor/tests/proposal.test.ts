import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TraceEvent } from "@loopy/contracts";
import workflowFixture from "../../../fixtures/workflows/valid-basic.json";
import { compileExtractionProposal } from "../src/compiler.ts";
import {
  createDeterministicExtractorAgent,
  extractImportedSession,
  prepareDeterministicExtractionInput,
} from "../src/index.ts";
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
    proposedPolicies: {
      ...(structuredClone(workflow.policies) as Record<string, unknown>),
      evidenceIds: [evidenceOne],
    },
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

  test("rejects a prepared evidence ID whose event membership was changed", async () => {
    const invalid = proposal();
    const firstNodeEvidence = (invalid.nodeEvidence as Array<Record<string, unknown>>)[0];
    if (!firstNodeEvidence) throw new Error("missing node evidence");
    firstNodeEvidence.eventIds = [secondEvent];
    const result = await extractWithRepair(input, { extract: () => invalid }, { maxAttempts: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics[0]?.code).toBe("PROPOSAL_EVIDENCE_MEMBERSHIP_MISMATCH");
  });

  test("rejects invented evidence IDs even when their source event is known", async () => {
    const invalid = proposal();
    const firstNodeEvidence = (invalid.nodeEvidence as Array<Record<string, unknown>>)[0];
    if (!firstNodeEvidence) throw new Error("missing node evidence");
    firstNodeEvidence.evidenceId = "13131313-1313-4131-8131-131313131313";
    (invalid.proposedPolicies as Record<string, unknown>).evidenceIds = [
      "13131313-1313-4131-8131-131313131313",
    ];
    const result = await extractWithRepair(input, { extract: () => invalid }, { maxAttempts: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("INVENTED_PROPOSAL_EVIDENCE");
  });

  test("requires an approval barrier for expected side effects", () => {
    const invalid = proposal({
      expectedSideEffects: ["workspace mutation"],
      status: "draft",
    });
    const result = compileExtractionProposal(invalid, input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.some((item) => item.code === "SIDE_EFFECT_APPROVAL_REQUIRED")).toBe(
        true,
      );
  });

  test("cross-validates proposed policies against workflow policies", () => {
    const invalid = proposal();
    const workflow = invalid.workflow as Record<string, unknown>;
    const policies = workflow.policies as Record<string, unknown>;
    const tools = policies.tools as Record<string, unknown>;
    invalid.proposedPolicies = {
      ...(structuredClone(policies) as Record<string, unknown>),
      evidenceIds: [evidenceOne],
    };
    tools.network = "restricted";
    const result = compileExtractionProposal(invalid, input);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics.some((item) => item.code === "PROPOSED_POLICY_MISMATCH")).toBe(
        true,
      );
  });

  test("rejects unsupported provider selection instead of falling back", async () => {
    const events = JSON.parse(
      readFileSync("fixtures/sessions/successful.json", "utf8"),
    ) as TraceEvent[];
    const result = await extractImportedSession(
      {
        id: importId,
        provider: "codex",
        session: events,
      },
      { provider: "unsupported-provider", maxAttempts: 1 },
    );
    expect(result.result.ok).toBe(false);
    if (!result.result.ok)
      expect(result.result.diagnostics[0]?.code).toBe("EXTRACTOR_AGENT_FAILED");
  });

  test("derives distinct read-only prompts and blocks mutating work", async () => {
    const source = JSON.parse(
      readFileSync("fixtures/sessions/successful.json", "utf8"),
    ) as TraceEvent[];
    const cat = structuredClone(source);
    const requested = cat.find((event) => event.type === "tool.requested");
    if (!requested || requested.type !== "tool.requested") throw new Error("missing tool request");
    requested.payload = { tool: "cat", input: { path: "/workspace/project/README.md" } };
    const git = await extractImportedSession({ id: importId, provider: "codex", session: source });
    const catExtraction = await extractImportedSession({
      id: secondEvent,
      provider: "codex",
      session: cat,
    });
    expect(git.result.ok).toBe(true);
    expect(catExtraction.result.ok).toBe(true);
    if (!git.result.ok || !catExtraction.result.ok) return;
    const gitPrompt = git.result.proposal.workflow.nodes.find(
      (node) => node.kind === "agent",
    )?.prompt;
    const catPrompt = catExtraction.result.proposal.workflow.nodes.find(
      (node) => node.kind === "agent",
    )?.prompt;
    expect(gitPrompt).toContain("git status");
    expect(catPrompt).toContain("cat");
    expect(gitPrompt).not.toBe(catPrompt);

    const mutating = structuredClone(source);
    const mutatingRequest = mutating.find((event) => event.type === "tool.requested");
    if (!mutatingRequest || mutatingRequest.type !== "tool.requested")
      throw new Error("missing tool request");
    mutatingRequest.payload = { tool: "apply_patch", input: { patch: "write file" } };
    const blocked = await extractImportedSession({
      id: evidenceTwo,
      provider: "codex",
      session: mutating,
    });
    expect(blocked.result.ok).toBe(true);
    if (blocked.result.ok) {
      expect(
        blocked.result.proposal.unresolvedQuestions.some((question) => question.blocksExecution),
      ).toBe(true);
      expect(blocked.result.proposal.workflow.policies.approval.requiredBefore).toContain("agent");
      const verifyCommands = blocked.result.proposal.workflow.nodes
        .filter((node) => node.kind === "verify")
        .flatMap((node) =>
          node.kind === "verify"
            ? node.commands.map((command) => `${command.command} ${command.args.join(" ")}`)
            : [],
        );
      expect(verifyCommands).toEqual(["bun test"]);
      expect(verifyCommands).not.toContain("bun --version");
    }
  });

  test("grounds inferred inputs in their matched non-primary variable evidence", async () => {
    const source = JSON.parse(
      readFileSync("fixtures/sessions/successful.json", "utf8"),
    ) as TraceEvent[];
    const extracted = await extractImportedSession({
      id: importId,
      provider: "codex",
      session: source,
    });
    expect(extracted.result.ok).toBe(true);
    if (!extracted.result.ok) return;

    const inferred = extracted.result.proposal.inferredInputs.find(
      (inputValue) => inputValue.name === "artifactPath",
    );
    const candidate = extracted.segmentation.candidateVariables.find(
      (variable) => variable.name === "artifactPath",
    );
    if (!inferred || !candidate) throw new Error("artifactPath candidate variable is missing");
    const variableEvidence = extracted.segmentation.evidence.filter(
      (evidence) =>
        evidence.kind === "variable" &&
        evidence.eventIds.every((eventId) => candidate.eventIds.includes(eventId)),
    );
    expect(variableEvidence.length).toBeGreaterThan(0);
    expect(inferred.evidenceIds).toEqual(variableEvidence.map((evidence) => evidence.evidenceId));
    expect(inferred.evidenceIds).not.toContain(
      extracted.segmentation.evidence.find((evidence) => evidence.kind === "feature")?.evidenceId,
    );
  });

  test("blocks an inferred input when prepared evidence does not cover its source events", async () => {
    const source = JSON.parse(
      readFileSync("fixtures/sessions/successful.json", "utf8"),
    ) as TraceEvent[];
    const prepared = prepareDeterministicExtractionInput({
      id: importId,
      provider: "codex",
      session: source,
    });
    const candidate = prepared.segmentation.candidateVariables.find(
      (variable) => variable.name === "artifactPath",
    );
    if (!candidate) throw new Error("artifactPath candidate variable is missing");
    const missingEvidenceIds = new Set(
      prepared.segmentation.evidence
        .filter(
          (evidence) =>
            evidence.kind === "variable" &&
            evidence.eventIds.every((eventId) => candidate.eventIds.includes(eventId)),
        )
        .map((evidence) => evidence.evidenceId),
    );
    const segmentation = {
      ...prepared.segmentation,
      evidence: prepared.segmentation.evidence.filter(
        (evidence) => !missingEvidenceIds.has(evidence.evidenceId),
      ),
    };
    const result = await extractWithRepair(
      prepared.input,
      createDeterministicExtractorAgent(segmentation),
      { maxAttempts: 1 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.proposal.inferredInputs.some((inputValue) => inputValue.name === "artifactPath"),
    ).toBe(false);
    expect(
      result.proposal.unresolvedQuestions.some(
        (question) =>
          question.blocksExecution &&
          question.question.includes("candidate variable 'artifactPath'"),
      ),
    ).toBe(true);
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
