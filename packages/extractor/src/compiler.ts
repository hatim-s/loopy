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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ").trim().toLowerCase();
}

const ALLOWED_VERIFIER_COMMANDS = new Set(["bun test", "bun run lint", "bun run typecheck"]);
const ALLOWED_VERIFIER_CHECKS = new Set(["test", "tests", "lint", "typecheck"]);

function verifierDiagnostics(
  proposal: ExtractionProposal,
  input?: DeterministicExtractionInput,
): ProposalDiagnostic[] {
  const nodes = proposal.workflow.nodes.filter((node) => node.kind === "verify");
  const diagnostics: ProposalDiagnostic[] = [];
  const blocked = proposal.unresolvedQuestions.some((question) => question.blocksExecution);
  if (nodes.length === 0) {
    // A blocked draft may legitimately have no executable verifier yet. It
    // must remain behind the unresolved-question/approval barrier instead of
    // receiving a fabricated probe command.
    if (blocked) return [];
    return [
      {
        kind: "compile",
        code: "VERIFIER_NODE_REQUIRED",
        message: "Every verifier requirement must be backed by an executable verify node.",
        path: "/workflow/nodes",
      },
    ];
  }
  const commands = nodes.flatMap((node) =>
    node.kind === "verify" ? node.commands.map((item) => commandLine(item.command, item.args)) : [],
  );
  const preparedKinds = new Map(
    input?.evidence.map((evidence) => [String(evidence.id), String(evidence.kind ?? "")]) ?? [],
  );
  const hasPreparedVerification = [...preparedKinds.values()].some(
    (kind) => kind === "verification",
  );
  const nodeEvidenceById = new Map<string, typeof proposal.nodeEvidence>();
  for (const evidence of proposal.nodeEvidence) {
    const records = nodeEvidenceById.get(evidence.nodeId) ?? [];
    records.push(evidence);
    nodeEvidenceById.set(evidence.nodeId, records);
  }
  const sourceEventsById = new Map(
    input?.sourceEvents?.map((event) => [String(event.id ?? ""), event]) ?? [],
  );
  nodes.forEach((node) => {
    const command = node.kind === "verify" ? node.commands : [];
    command.forEach((item, commandIndex) => {
      if (!ALLOWED_VERIFIER_COMMANDS.has(commandLine(item.command, item.args))) {
        diagnostics.push({
          kind: "compile",
          code: "VERIFIER_COMMAND_NOT_ALLOWLISTED",
          message:
            "Verifier commands must use an allowlisted canonical tests, lint, or typecheck command.",
          path: `/workflow/nodes/${proposal.workflow.nodes.indexOf(node)}/commands/${commandIndex}`,
        });
      }
    });
    if (hasPreparedVerification) {
      const evidence = nodeEvidenceById.get(node.id) ?? [];
      const verificationEvidence = evidence.filter(
        (record) => preparedKinds.get(record.evidenceId) === "verification",
      );
      const canonicalEvent = verificationEvidence
        .flatMap((record) => record.eventIds)
        .map((eventId) => sourceEventsById.get(eventId))
        .find((event) => {
          if (!event || typeof event.type !== "string") return false;
          if (event.type !== "verification.started" && event.type !== "verification.result")
            return false;
          const payload = isRecord(event.payload) ? event.payload : undefined;
          const check = typeof payload?.check === "string" ? payload.check.toLowerCase() : "";
          return ALLOWED_VERIFIER_CHECKS.has(check);
        });
      if (verificationEvidence.length === 0 || (sourceEventsById.size > 0 && !canonicalEvent)) {
        diagnostics.push({
          kind: "evidence",
          code: "VERIFIER_EVIDENCE_NOT_CANONICAL",
          message: "Verifier nodes must be grounded in prepared canonical verification evidence.",
          path: `/workflow/nodes/${proposal.workflow.nodes.indexOf(node)}`,
        });
      }
    }
  });
  const searchable = nodes.map((node) => {
    if (node.kind !== "verify") return "";
    return [
      node.name,
      node.description ?? "",
      ...node.tags,
      ...node.commands.map((item) => commandLine(item.command, item.args)),
    ]
      .join(" ")
      .toLowerCase();
  });
  proposal.verifierRequirements.forEach((requirement, index) => {
    if (!ALLOWED_VERIFIER_CHECKS.has(requirement.check.trim().toLowerCase())) {
      diagnostics.push({
        kind: "compile",
        code: "VERIFIER_CHECK_NOT_ALLOWLISTED",
        message: "Verifier checks must be tests, lint, or typecheck.",
        path: `/verifierRequirements/${index}/check`,
      });
      return;
    }
    const requiredCommand = requirement.command?.trim().toLowerCase();
    const commandMatched =
      !requiredCommand || commands.some((command) => command === requiredCommand);
    const checkMatched = searchable.some((value) =>
      value.includes(requirement.check.trim().toLowerCase()),
    );
    if (!commandMatched || !checkMatched) {
      diagnostics.push({
        kind: "compile",
        code: "VERIFIER_REQUIREMENT_MISMATCH",
        message: `Verifier requirement '${requirement.check}' is not represented by an executable verify-node command/check.`,
        path: `/verifierRequirements/${index}`,
      });
    }
  });
  return diagnostics;
}

function policyDiagnostics(proposal: ExtractionProposal): ProposalDiagnostic[] {
  const diagnostics: ProposalDiagnostic[] = [];
  for (const key of ["tools", "workspace", "approval", "budget", "concurrency"] as const) {
    const value = proposal.proposedPolicies[key];
    const actual = proposal.workflow.policies[key];
    if (!sameValue(value, actual)) {
      diagnostics.push({
        kind: "compile",
        code: "PROPOSED_POLICY_MISMATCH",
        message: `Proposed policy '${key}' does not match workflow.policies.`,
        path: `/proposedPolicies/${key}`,
      });
    }
  }
  return diagnostics;
}

function sideEffectDiagnostics(proposal: ExtractionProposal): ProposalDiagnostic[] {
  if (proposal.expectedSideEffects.length === 0) return [];
  const approval = proposal.workflow.policies.approval;
  const hasBarrier = approval.requiredBefore.length > 0 || approval.sideEffectLabels.length > 0;
  if (hasBarrier) return [];
  return [
    {
      kind: "approval",
      code: "SIDE_EFFECT_APPROVAL_REQUIRED",
      message:
        "Expected side effects require an approval barrier or blocking approval question before execution.",
      path: "/workflow/policies/approval",
    },
  ];
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
  const diagnostics = [
    ...workflowDiagnostics(compiled.diagnostics),
    ...verifierDiagnostics(parsed.proposal, input),
    ...policyDiagnostics(parsed.proposal),
    ...sideEffectDiagnostics(parsed.proposal),
  ];
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
