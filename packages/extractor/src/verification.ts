import type { TraceEvent } from "@loopy/contracts";
import { stableEvidenceId } from "./evidence.ts";
import { observedCommand, sameToolCall } from "./intent.ts";
import type { SegmentationResult } from "./segmentation.ts";

export const PROJECT_CHECKS = new Map([
  ["bun test", "tests"],
  ["bun run lint", "lint"],
  ["bun run typecheck", "typecheck"],
  ["npm test", "tests"],
  ["npm run lint", "lint"],
  ["npm run typecheck", "typecheck"],
  ["pnpm test", "tests"],
  ["pnpm run lint", "lint"],
  ["pnpm run typecheck", "typecheck"],
  ["yarn test", "tests"],
  ["yarn run lint", "lint"],
  ["yarn run typecheck", "typecheck"],
]);

export function observedCheck(event: TraceEvent): string | undefined {
  if (event.type === "verification.started" || event.type === "verification.result")
    return "command" in event.payload ? event.payload.command : undefined;
  return observedCommand(event);
}

/** Attach evidence to existing events. Never invent source events or infer success from assistant prose. */
export function includeToolVerification(segmentation: SegmentationResult): void {
  for (const event of segmentation.events) {
    const command = observedCommand(event);
    const check = command ? PROJECT_CHECKS.get(command) : undefined;
    if (!check || !event.toolCallId) continue;
    const result = segmentation.events.find(
      (candidate) => candidate.type === "tool.completed" && sameToolCall(event, candidate),
    );
    if (
      !result ||
      result.type !== "tool.completed" ||
      result.payload.exitCode !== 0 ||
      (result.payload as Record<string, unknown>).isError === true
    )
      continue;
    if (segmentation.verification.some((item) => item.eventIds.includes(event.id))) continue;
    const eventIds = [event.id, result.id];
    const evidenceId = stableEvidenceId("verification", eventIds);
    segmentation.verification.push({
      verificationId: evidenceId,
      eventIds,
      check,
      result: "passed",
    });
    segmentation.evidence.push({
      evidenceId,
      eventIds,
      kind: "verification",
      firstSequence: event.sequence,
      lastSequence: result.sequence,
      summary: `Observed successful project check: ${command}.`,
    });
  }
}
