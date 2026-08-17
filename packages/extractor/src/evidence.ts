import { createHash } from "node:crypto";
import type { TraceEvent } from "@loopy/contracts";

export type EvidenceKind =
  | "goal_episode"
  | "tool_cluster"
  | "failure"
  | "recovery"
  | "verification"
  | "feature"
  | "variable";

export interface EvidenceWarning {
  code: "missing_event" | "duplicate_event" | "invalid_causal_reference" | "empty_reference";
  message: string;
  eventId?: string;
  referencedEventId?: string;
}

export interface EvidenceReference {
  evidenceId: string;
  kind: EvidenceKind;
  eventIds: string[];
  firstSequence: number;
  lastSequence: number;
  /** A bounded deterministic label, not an LLM-generated explanation. */
  summary: string;
}

export interface EvidenceResult {
  references: EvidenceReference[];
  warnings: EvidenceWarning[];
}

const EVIDENCE_NAMESPACE = "loopy-extraction-evidence-v1";

/** Stable UUID-shaped identifier derived solely from the evidence kind and actual event IDs. */
export function stableEvidenceId(kind: EvidenceKind, eventIds: readonly string[]): string {
  const canonical = `${EVIDENCE_NAMESPACE}\0${kind}\0${[...new Set(eventIds)].sort().join("\0")}`;
  const digest = createHash("sha256").update(canonical).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sequenceBounds(
  events: readonly TraceEvent[],
  eventIds: readonly string[],
): [number, number] {
  const selected = events.filter((event) => eventIds.includes(event.id));
  const sequences = selected.map((event) => event.sequence);
  return [Math.min(...sequences), Math.max(...sequences)];
}

/**
 * Build stable references and explicitly report missing or duplicate causal IDs.
 * References never synthesize IDs: every reference points at an event in the input.
 */
export function createEvidenceReferences(
  events: readonly TraceEvent[],
  groups: readonly { kind: EvidenceKind; eventIds: readonly string[]; summary?: string }[],
): EvidenceResult {
  const known = new Map<string, TraceEvent>();
  const warnings: EvidenceWarning[] = [];
  for (const event of events) {
    if (known.has(event.id))
      warnings.push({
        code: "duplicate_event",
        message: `Event '${event.id}' occurs more than once.`,
        eventId: event.id,
      });
    known.set(event.id, event);
  }
  const references: EvidenceReference[] = [];
  const seenEvidence = new Set<string>();
  for (const group of groups) {
    const uniqueIds = [...new Set(group.eventIds)];
    if (uniqueIds.length === 0) {
      warnings.push({
        code: "empty_reference",
        message: `Cannot create ${group.kind} evidence without event IDs.`,
      });
      continue;
    }
    const validIds: string[] = [];
    for (const eventId of uniqueIds) {
      if (!known.has(eventId)) {
        warnings.push({
          code: "missing_event",
          message: `Evidence references missing event '${eventId}'.`,
          referencedEventId: eventId,
        });
      } else validIds.push(eventId);
    }
    if (validIds.length === 0) continue;
    const evidenceId = stableEvidenceId(group.kind, validIds);
    if (seenEvidence.has(evidenceId)) continue;
    seenEvidence.add(evidenceId);
    const ordered = validIds.slice().sort((left, right) => {
      const a = known.get(left)?.sequence ?? Number.MAX_SAFE_INTEGER;
      const b = known.get(right)?.sequence ?? Number.MAX_SAFE_INTEGER;
      return a - b || left.localeCompare(right);
    });
    const [firstSequence, lastSequence] = sequenceBounds(events, ordered);
    references.push({
      evidenceId,
      kind: group.kind,
      eventIds: ordered,
      firstSequence,
      lastSequence,
      summary:
        group.summary?.trim() ||
        `${group.kind} evidence from ${ordered.length} event${ordered.length === 1 ? "" : "s"}.`,
    });
  }
  references.sort(
    (a, b) =>
      a.firstSequence - b.firstSequence ||
      a.kind.localeCompare(b.kind) ||
      a.evidenceId.localeCompare(b.evidenceId),
  );
  warnings.sort(
    (a, b) =>
      (a.eventId ?? a.referencedEventId ?? "").localeCompare(
        b.eventId ?? b.referencedEventId ?? "",
      ) || a.code.localeCompare(b.code),
  );
  return { references, warnings };
}

/** Validate parentEventId edges and return explicit warnings for broken causal links/cycles. */
export function validateCausalReferences(events: readonly TraceEvent[]): EvidenceWarning[] {
  const known = new Set(events.map((event) => event.id));
  const warnings: EvidenceWarning[] = [];
  const parentById = new Map<string, string>();
  for (const event of events) {
    if (!event.parentEventId) continue;
    if (!known.has(event.parentEventId)) {
      warnings.push({
        code: "invalid_causal_reference",
        message: `Event '${event.id}' references missing parent event '${event.parentEventId}'.`,
        eventId: event.id,
        referencedEventId: event.parentEventId,
      });
    } else parentById.set(event.id, event.parentEventId);
  }
  for (const start of parentById.keys()) {
    const path = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor) {
      if (path.has(cursor)) {
        warnings.push({
          code: "invalid_causal_reference",
          message: `Causal parent references contain a cycle at '${cursor}'.`,
          eventId: start,
          referencedEventId: cursor,
        });
        break;
      }
      path.add(cursor);
      cursor = parentById.get(cursor);
    }
  }
  return warnings.sort(
    (a, b) =>
      (a.eventId ?? "").localeCompare(b.eventId ?? "") ||
      (a.referencedEventId ?? "").localeCompare(b.referencedEventId ?? ""),
  );
}
