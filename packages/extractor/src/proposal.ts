import {
  type ExtractionProposal,
  ExtractionProposalSchema,
  type InferredInputV1,
} from "@loopy/contracts";
import { buildExtractionPrompt, type DeterministicExtractionInput } from "./prompt.ts";

export type ProposalDiagnosticKind = "schema" | "evidence" | "compile" | "approval";

export interface ProposalDiagnostic {
  kind: ProposalDiagnosticKind;
  code: string;
  message: string;
  path?: string;
}

export interface ExtractorAgentRequest extends DeterministicExtractionInput {
  prompt: string;
  attempt: number;
  diagnostics: readonly ProposalDiagnostic[];
}

/** Provider adapters implement this one method; no provider-specific type leaks into extraction. */
export interface ExtractorAgent {
  extract(input: ExtractorAgentRequest): unknown | Promise<unknown>;
}

export interface ParsedProposal {
  ok: true;
  proposal: ExtractionProposal;
  diagnostics: readonly ProposalDiagnostic[];
}

export interface InvalidProposal {
  ok: false;
  proposal?: undefined;
  diagnostics: readonly ProposalDiagnostic[];
}

export type ProposalParseResult = ParsedProposal | InvalidProposal;

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "" : `/${path.map(String).join("/")}`;
}

function schemaDiagnostics(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): ProposalDiagnostic[] {
  return error.issues.map((issue) => ({
    kind: "schema",
    code: "PROPOSAL_SCHEMA_INVALID",
    message: issue.message,
    path: issuePath(issue.path),
  }));
}

function eventIdsFromInput(input: DeterministicExtractionInput): Set<string> {
  const fromEvents = input.sourceEvents?.map((event) => String(event.id ?? "")) ?? [];
  return new Set([...(input.sourceEventIds ?? []), ...fromEvents]);
}

function addUnknownEventDiagnostics(
  proposal: ExtractionProposal,
  sourceEventIds: ReadonlySet<string>,
): ProposalDiagnostic[] {
  const diagnostics: ProposalDiagnostic[] = [];
  const check = (eventIds: readonly string[], path: string): void => {
    for (const [index, eventId] of eventIds.entries()) {
      if (!sourceEventIds.has(eventId)) {
        diagnostics.push({
          kind: "evidence",
          code: "UNKNOWN_SOURCE_EVENT",
          message: `Evidence references source event '${eventId}', which is not present in the imported trace.`,
          path: `${path}/${index}`,
        });
      }
    }
  };
  proposal.nodeEvidence.forEach((evidence, index) => {
    check(evidence.eventIds, `/nodeEvidence/${index}/eventIds`);
  });
  proposal.removedDetours.forEach((detour, index) => {
    check(detour.eventIds, `/removedDetours/${index}/eventIds`);
  });
  return diagnostics;
}

function validateInferredInputs(raw: unknown, proposal: ExtractionProposal): ProposalDiagnostic[] {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as Record<string, unknown>).inferredInputs)
  ) {
    return [];
  }
  const evidenceIds = new Set(proposal.nodeEvidence.map((item) => item.evidenceId));
  const diagnostics: ProposalDiagnostic[] = [];
  (raw as { inferredInputs: unknown[] }).inferredInputs.forEach((input, index) => {
    if (!input || typeof input !== "object") return;
    const ids = (input as Record<string, unknown>).evidenceIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
      diagnostics.push({
        kind: "evidence",
        code: "INFERRED_INPUT_EVIDENCE_REQUIRED",
        message: "Every inferred input must carry one or more evidenceIds.",
        path: `/inferredInputs/${index}/evidenceIds`,
      });
      return;
    }
    ids.forEach((id, evidenceIndex) => {
      if (!evidenceIds.has(id)) {
        diagnostics.push({
          kind: "evidence",
          code: "UNKNOWN_PROPOSAL_EVIDENCE",
          message: `Inferred input references unknown proposal evidence '${id}'.`,
          path: `/inferredInputs/${index}/evidenceIds/${evidenceIndex}`,
        });
      }
    });
  });
  return diagnostics;
}

/** Parse only with the versioned contract, then enforce source-trace evidence provenance. */
export function parseExtractionProposal(
  output: unknown,
  input?: DeterministicExtractionInput,
): ProposalParseResult {
  const parsed = ExtractionProposalSchema.safeParse(output);
  if (!parsed.success) return { ok: false, diagnostics: schemaDiagnostics(parsed.error) };

  const diagnostics = [
    ...(input ? addUnknownEventDiagnostics(parsed.data, eventIdsFromInput(input)) : []),
    ...validateInferredInputs(output, parsed.data),
  ];
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, proposal: parsed.data, diagnostics: [] };
}

export function proposalRequest(
  input: DeterministicExtractionInput,
  attempt: number,
  diagnostics: readonly ProposalDiagnostic[] = [],
): ExtractorAgentRequest {
  return { ...input, prompt: buildExtractionPrompt(input), attempt, diagnostics };
}

export type { DeterministicExtractionInput } from "./prompt.ts";
export type { InferredInputV1 };
export const parseProposal = parseExtractionProposal;
