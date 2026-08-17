import type { ExtractionProposal } from "@loopy/contracts";
import {
  compileExtractionProposal,
  type ProposalApproval,
  type ProposalCompilation,
} from "./compiler.ts";
import type { DeterministicExtractionInput } from "./prompt.ts";
import { type ExtractorAgent, type ProposalDiagnostic, proposalRequest } from "./proposal.ts";

export interface RepairOptions {
  /** Maximum number of agent calls, including the initial extraction. */
  maxAttempts?: number;
}

export interface RepairAttemptAudit {
  attempt: number;
  phase: "initial" | "repair";
  accepted: boolean;
  diagnostics: readonly ProposalDiagnostic[];
}

export interface ExtractionRunSuccess {
  ok: true;
  proposal: ExtractionProposal;
  plan: NonNullable<Extract<ProposalCompilation, { ok: true }>["plan"]>;
  approval: ProposalApproval;
  attempts: number;
  audits: readonly RepairAttemptAudit[];
  diagnostics: readonly ProposalDiagnostic[];
}

export interface ExtractionRunFailure {
  ok: false;
  proposal?: Extract<ProposalCompilation, { ok: false }>["proposal"];
  plan?: undefined;
  approval: "rejected";
  attempts: number;
  audits: readonly RepairAttemptAudit[];
  diagnostics: readonly ProposalDiagnostic[];
}

export type ExtractionRunResult = ExtractionRunSuccess | ExtractionRunFailure;

const DEFAULT_MAX_ATTEMPTS = 3;

function maxAttempts(options: RepairOptions): number {
  const value = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  return value;
}

/**
 * Run extraction with a finite, structured repair loop. Diagnostics from the
 * previous attempt are part of the next request; no retry is hidden in an
 * agent or implemented through recursive calls.
 */
export async function extractWithRepair(
  input: DeterministicExtractionInput,
  agent: ExtractorAgent,
  options: RepairOptions = {},
): Promise<ExtractionRunResult> {
  const bound = maxAttempts(options);
  const audits: RepairAttemptAudit[] = [];
  let diagnostics: readonly ProposalDiagnostic[] = [];
  let lastProposal: Extract<ProposalCompilation, { ok: false }>["proposal"];

  for (let attempt = 1; attempt <= bound; attempt += 1) {
    const request = proposalRequest(input, attempt, diagnostics);
    let output: unknown;
    try {
      output = await agent.extract(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics = [
        {
          kind: "schema",
          code: "EXTRACTOR_AGENT_FAILED",
          message: `Extractor agent failed: ${message}`,
        },
      ];
      audits.push({
        attempt,
        phase: attempt === 1 ? "initial" : "repair",
        accepted: false,
        diagnostics,
      });
      continue;
    }

    const result = compileExtractionProposal(output, input);
    if (result.ok) {
      audits.push({
        attempt,
        phase: attempt === 1 ? "initial" : "repair",
        accepted: true,
        diagnostics: result.diagnostics,
      });
      return {
        ok: true,
        proposal: result.proposal,
        plan: result.plan,
        approval: result.approval,
        attempts: attempt,
        audits,
        diagnostics: result.diagnostics,
      };
    }

    diagnostics = result.diagnostics;
    lastProposal = result.proposal;
    audits.push({
      attempt,
      phase: attempt === 1 ? "initial" : "repair",
      accepted: false,
      diagnostics,
    });
  }

  return {
    ok: false,
    proposal: lastProposal,
    approval: "rejected",
    attempts: bound,
    audits,
    diagnostics,
  };
}

export const runExtraction = extractWithRepair;
export const repairExtractionProposal = extractWithRepair;
