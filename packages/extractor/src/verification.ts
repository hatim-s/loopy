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

export function verificationDirectory(
  events: readonly TraceEvent[],
  sourceWorkspaceRoots: Readonly<Record<string, string>> = {},
): { ok: true; cwd?: string } | { ok: false; reason: string } {
  const values: unknown[] = [];
  const collect = (input: unknown): void => {
    if (!input || typeof input !== "object") return;
    for (const [key, value] of Object.entries(input)) {
      if (["cwd", "workdir", "workingDirectory"].includes(key)) values.push(value);
      else if (value && typeof value === "object") collect(value);
    }
  };
  for (const event of events) {
    if (event.type === "tool.requested") collect(event.payload.input);
    if (event.type === "verification.result") collect(event.payload.details);
  }
  const runIds = new Set(events.map((event) => event.runId));
  const first = events[0];
  const root = runIds.size === 1 && first ? sourceWorkspaceRoots[first.runId] : undefined;
  const safeRoot =
    root?.startsWith("/") && root !== "/" && !root.includes("\\") && !root.split("/").includes("..")
      ? root.replace(/\/+$/, "")
      : undefined;
  const normalized = new Set<string>();
  for (const observed of values) {
    const value =
      typeof observed === "string" &&
      safeRoot &&
      (observed === safeRoot || observed.startsWith(`${safeRoot}/`))
        ? observed.slice(safeRoot.length).replace(/^\/+/, "") || "."
        : observed;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.startsWith("/") ||
      value.includes("\\") ||
      /^[a-z]:/i.test(value) ||
      value.split("/").includes("..")
    )
      return {
        ok: false,
        reason: "source working directory cannot be mapped to a project-relative path",
      };
    normalized.add(
      value
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/") || ".",
    );
  }
  if (normalized.size > 1) return { ok: false, reason: "source working directories conflict" };
  const cwd = [...normalized][0];
  return { ok: true, ...(cwd ? { cwd } : {}) };
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
      (result.payload.exitCode !== undefined
        ? result.payload.exitCode !== 0
        : (result.payload as Record<string, unknown>).isError !== false) ||
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
      summary:
        result.payload.exitCode === 0
          ? `Observed project check exited with code 0: ${command}.`
          : `Tool reported successful completion for ${command}; the source did not record a numeric exit code.`,
    });
  }
}
