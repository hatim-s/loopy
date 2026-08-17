import { describe, expect, it } from "vitest";
import { normalizeExtractionReview, snapshotFrom, topologyFrom } from "../src/app/pages";

describe("Studio runtime normalizers", () => {
  it("decodes the scheduler snapshot and its plan topology", () => {
    const snapshot = snapshotFrom(
      {
        run: {
          runId: "run-1",
          workflowId: "workflow-1",
          workflowVersion: 3,
          status: "running",
          plan: {
            nodes: [{ id: "start", name: "Start", kind: "agent" }],
            edges: [],
          },
        },
        events: [{ id: "event-1", sequence: 1, type: "run.started" }],
        attempts: [],
      },
      "run-1",
    );
    expect(snapshot).toMatchObject({
      workflowId: "workflow-1",
      workflowVersion: 3,
      status: "live",
      topology: { nodes: [{ id: "start", name: "Start" }] },
    });
  });

  it("maps the runtime succeeded status to the completed Studio state", () => {
    expect(snapshotFrom({ run: { status: "succeeded" } }, "run-1").status).toBe("completed");
  });

  it("decodes a persisted workflow definition for graph rendering", () => {
    expect(
      topologyFrom({
        definition: {
          nodes: [{ id: "a" }, { id: "b" }],
          edges: [{ id: "a-b", source: "a", target: "b", label: "next" }],
        },
      }),
    ).toEqual({
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ id: "a-b", source: "a", target: "b", label: "next" }],
    });
  });

  it("projects the local API extraction record into an actionable review", () => {
    const review = normalizeExtractionReview({
      job: { id: "job-1", importId: "import-1" },
      import: { provider: "codex", source: "session.jsonl", session: [] },
      proposal: {
        id: "proposal-1",
        importId: "import-1",
        status: "draft",
        workflow: { nodes: [{ id: "node-1", name: "Do work" }] },
        nodeEvidence: [{ evidenceId: "evidence-1", eventIds: ["event-1"], nodeId: "node-1" }],
        warnings: [{ message: "Imported evidence is lossy" }],
      },
    });
    expect(review).toMatchObject({
      importId: "import-1",
      proposalId: "proposal-1",
      sourceLabel: "codex · session.jsonl",
      evidence: [{ evidenceId: "evidence-1", eventIds: ["event-1"] }],
      warnings: ["Imported evidence is lossy"],
      status: "draft",
    });
  });
});
