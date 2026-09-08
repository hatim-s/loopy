// @vitest-environment jsdom

import { ExtractionProposalSchema, WorkflowDefinitionSchema } from "@loopy/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import workflowFixture from "../../../fixtures/workflows/valid-basic.json";
import { ExtractionEdits } from "../src/features/extraction-edits";
import type { ExtractionReviewModel } from "../src/features/types";

const localQuestion =
  "Explicitly allow Claude tools Read, Edit, Write and Bash to run this coding workflow.";
const networkQuestion = "The provider cannot enforce network isolation.";

function reviewModel(): ExtractionReviewModel {
  const workflow = WorkflowDefinitionSchema.parse(workflowFixture);
  workflow.policies.tools.network = "disabled";
  const nodeEvidence = workflow.nodes.map((node) => ({
    evidenceId: node.id,
    nodeId: node.id,
    eventIds: [workflow.id],
    rationale: "Recorded in the source session",
  }));
  return {
    importId: workflow.id,
    sourceLabel: "Claude session",
    sourceEvents: [],
    evidence: [],
    status: "blocked",
    proposal: ExtractionProposalSchema.parse({
      schemaVersion: "1",
      id: workflow.id,
      importId: workflow.id,
      createdAt: "2026-09-08T00:00:00.000Z",
      workflow,
      nodeEvidence,
      verifierRequirements: [
        {
          check: "Review output",
          rationale: "Verify result",
          evidenceIds: [workflow.nodes[0]?.id],
        },
      ],
      proposedPolicies: { ...workflow.policies, evidenceIds: [workflow.nodes[0]?.id] },
      unresolvedQuestions: [localQuestion, networkQuestion].map((question) => ({
        question,
        blocksExecution: true,
      })),
    }),
  };
}

afterEach(cleanup);

test("local tool consent starts unchecked and never grants network access implicitly", () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const dirty = vi.fn();
  render(<ExtractionEdits model={reviewModel()} onSave={save} onDirty={dirty} />);
  const local = screen.getByRole<HTMLInputElement>("checkbox", { name: /Allow Claude tools/ });
  const network = screen.getByRole<HTMLInputElement>("checkbox", {
    name: /Allow provider network access/,
  });
  expect(local.checked).toBe(false);
  expect(network.checked).toBe(false);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Save review changes" }).disabled,
  ).toBe(true);
  fireEvent.click(local);
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Save review changes" }));
  expect(save).toHaveBeenCalledWith({ resolutions: [], allowLocalTools: true });
  expect(network.checked).toBe(false);
});

test("network consent does not grant local tools and completed reviews cannot add consent", () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const model = reviewModel();
  const { rerender } = render(<ExtractionEdits model={model} onSave={save} onDirty={vi.fn()} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Allow provider network access/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save review changes" }));
  expect(save).toHaveBeenCalledWith({ resolutions: [], allowNetworkAccess: true });
  rerender(
    <ExtractionEdits model={{ ...model, status: "approved" }} onSave={save} onDirty={vi.fn()} />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save review changes" })).toBeNull();
});
