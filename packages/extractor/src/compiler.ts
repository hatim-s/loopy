import type { ExtractionProposal } from "@loopy/contracts";
import { compileWorkflow, type WorkflowDiagnostic } from "@loopy/runtime";
import type { DeterministicExtractionInput } from "./prompt.ts";
import { type ProposalDiagnostic, parseExtractionProposal } from "./proposal.ts";

export type ProposalApproval = "approved" | "draft" | "rejected";

export interface CompiledProposal {
  ok: true;
  proposal: ExtractionProposal;
  plan: NonNullable<ReturnType<typeof compileWorkflow>["plan"]>;
  diagnostics: readonly ProposalDiagnostic[];
  approval: ProposalApproval;
}

export interface RejectedCompilation {
  ok: false;
  proposal?: ExtractionProposal;
  plan?: undefined;
  diagnostics: readonly ProposalDiagnostic[];
  approval: "rejected";
}

export type ProposalCompilation = CompiledProposal | RejectedCompilation;

function workflowDiagnostics(diagnostics: readonly WorkflowDiagnostic[]): ProposalDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    kind: "compile",
    code: diagnostic.code,
    message: diagnostic.message,
    path: diagnostic.path,
  }));
}

/**
 * Parse and graph-compile one proposal. This is intentionally a single
 * bounded operation; retries belong to repair.ts and never recurse here.
 */
export function compileExtractionProposal(
  output: unknown,
  input?: DeterministicExtractionInput,
): ProposalCompilation {
  const parsed = parseExtractionProposal(output, input);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics, approval: "rejected" };

  const compiled = compileWorkflow(parsed.proposal.workflow);
  const diagnostics = workflowDiagnostics(compiled.diagnostics);
  if (!compiled.ok || diagnostics.length > 0 || !compiled.plan) {
    return {
      ok: false,
      proposal: parsed.proposal,
      diagnostics,
      approval: "rejected",
    };
  }

  const hasBlockingQuestion = parsed.proposal.unresolvedQuestions.some(
    (question) => question.blocksExecution,
  );
  if (parsed.proposal.status === "approved" && hasBlockingQuestion) {
    return {
      ok: false,
      proposal: parsed.proposal,
      diagnostics: [
        {
          kind: "approval",
          code: "APPROVAL_BLOCKED_BY_QUESTION",
          message: "Approval is rejected while blocking unresolved questions remain.",
          path: "/unresolvedQuestions",
        },
      ],
      approval: "rejected",
    };
  }

  return {
    ok: true,
    proposal: parsed.proposal,
    plan: compiled.plan,
    diagnostics: [],
    approval: parsed.proposal.status === "approved" ? "approved" : "draft",
  };
}

export const compileProposal = compileExtractionProposal;
