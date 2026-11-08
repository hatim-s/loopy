import { type RunSnapshotView, routes } from "@loopy/contract";
import { controlledFailure, matchesControlledFailure } from "../playground/outcomes";
import type { OwnedDaemon } from "./daemon";

const approvalDenied = "PLAYGROUND_APPROVAL_DENIED: security publication requires approval.";

export function expectedFailure(slug: string, ordinal: number) {
  if (slug === "playground-c-security-review" && ordinal === 8) {
    return approvalDenied;
  }

  if (ordinal !== 5) {
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

  const graph = await daemon.request(`/runs/${snapshot.run.id}/graph`, routes.runGraph.response);

  return matchesControlledFailure({ label: rule.label, marker }, snapshot, graph);
}
