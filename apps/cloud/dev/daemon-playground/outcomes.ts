import { type RunSnapshotView, routes } from "@loopy/contract";
import { controlledFailure, matchesControlledFailure } from "../playground/outcomes";
import type { OwnedDaemon } from "./daemon";
import { approves, runInput } from "./plan";

const approvalDenied = "PLAYGROUND_APPROVAL_DENIED: security publication requires approval.";

export function expectedFailure(slug: string, ordinal: number) {
  if (slug === "playground-c-security-review" && !approves(ordinal)) {
    return approvalDenied;
  }

  if (!runInput(ordinal).fail) {
    return null;
  }

  const rule = controlledFailure(slug);

  if (!rule) {
    throw new Error(`No controlled-failure expectation for ${slug}.`);
  }

  return rule.marker;
}

export async function matchOutcome(
  daemon: OwnedDaemon,
  snapshot: RunSnapshotView,
  marker: string | null,
) {
  if (marker === null) {
    return snapshot.run.status === "succeeded";
  }

  const rule = controlledFailure(snapshot.run.slug);

  if (!rule || snapshot.run.status !== "failed" || !snapshot.run.error.includes(marker)) {
    return false;
  }

  const graph = await daemon.call(routes.runGraph, { params: { id: snapshot.run.id } });

  return matchesControlledFailure({ label: rule.label, marker }, snapshot, graph);
}
