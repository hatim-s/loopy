/**
 * The prompt is deliberately a data-only boundary.  Provider adapters may
 * choose how to present it, but they must not have to know about trace
 * segmentation or the proposal contract.
 */
export const EXTRACTION_PROMPT_VERSION = "loopy.extraction-proposal.v1" as const;

export type DeterministicRecord = Readonly<Record<string, unknown>>;

export interface ExtractionSegmentInput extends DeterministicRecord {
  id: string;
  eventIds?: readonly string[];
}

export interface ExtractionFeatureInput extends DeterministicRecord {
  id: string;
  eventIds?: readonly string[];
}

export interface ExtractionEvidenceInput extends DeterministicRecord {
  id: string;
  eventIds?: readonly string[];
}

/**
 * This is the complete, deterministic input given to an extractor agent.
 * `sourceEvents` is preferred because it retains the trace envelope for
 * prompt construction; `sourceEventIds` is accepted for callers that have
 * already redacted the event bodies.
 */
export interface DeterministicExtractionInput {
  importId: string;
  sourceEvents?: readonly DeterministicRecord[];
  sourceEventIds?: readonly string[];
  segments: readonly ExtractionSegmentInput[];
  features: readonly ExtractionFeatureInput[];
  evidence: readonly ExtractionEvidenceInput[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function stableItems<T extends DeterministicRecord>(items: readonly T[]): T[] {
  return [...items]
    .map((item) => canonical(item) as T)
    .sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? "")));
}

/** Normalize an extraction input so identical evidence always produces the same prompt. */
export function normalizeExtractionInput(
  input: DeterministicExtractionInput,
): DeterministicExtractionInput {
  const sourceEvents = input.sourceEvents ? stableItems(input.sourceEvents) : undefined;
  const sourceEventIds = [
    ...new Set([
      ...(input.sourceEventIds ?? []),
      ...(sourceEvents?.map((event) => String(event.id ?? "")) ?? []),
    ]),
  ].sort();
  return {
    importId: input.importId,
    sourceEvents,
    sourceEventIds,
    segments: stableItems(input.segments),
    features: stableItems(input.features),
    evidence: stableItems(input.evidence),
  };
}

/**
 * Build the provider-neutral instruction sent to an extractor agent.
 * Observed material and inference are intentionally separate sections; an
 * agent must never silently promote an inference to observed evidence.
 */
export function buildExtractionPrompt(input: DeterministicExtractionInput): string {
  const normalized = normalizeExtractionInput(input);
  const payload = JSON.stringify(canonical(normalized), null, 2);
  return [
    `Prompt version: ${EXTRACTION_PROMPT_VERSION}`,
    "You are proposing a reusable workflow from an imported coding-agent trace.",
    "Treat the OBSERVED EVIDENCE section as authoritative and immutable.",
    "Anything not directly supported there is an INFERENCE and must be marked as such.",
    "Every proposed node, inferred variable, verifier requirement, and policy must include one or more evidence IDs.",
    "Use only source event IDs supplied in OBSERVED EVIDENCE; never invent event IDs.",
    "Return one JSON object matching ExtractionProposalSchema (schemaVersion 1). Do not return markdown or commentary.",
    "Leave status as draft unless there are no blocking unresolved questions and the workflow is fully supported.",
    "\nOBSERVED EVIDENCE",
    payload,
  ].join("\n");
}

export const createExtractionPrompt = buildExtractionPrompt;
export const generateExtractionPrompt = buildExtractionPrompt;
