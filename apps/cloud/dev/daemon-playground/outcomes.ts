import { type RunSnapshotView, routes } from "@loopy/contract";
import type { OwnedDaemon } from "./daemon";

const failureLabels = new Map([
  ["playground-b-retry-marker", "retry-update"],
  ["playground-c-repository-validation", "repository-report"],
  ["playground-c-security-review", "publish-report"],
]);

const failures = {
  "playground-a-lint-report": "Controlled lint gate failure requested by fixture input.",
  "playground-b-parallel-build": "Controlled build size policy failure",
  "playground-b-retry-marker": "Controlled CI retry failure. The retry marker is safe to inspect.",
  "playground-c-repository-validation":
    "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
  "playground-c-security-review":
    "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
};

export function expectedFailure(slug: string, ordinal: number) {
  if (slug === "playground-c-security-review" && ordinal === 8) {
    return "PLAYGROUND_APPROVAL_DENIED: security publication requires approval.";
  }

  if (ordinal !== 5) {
    return null;
  }

  const marker = Object.entries(failures).find(([name]) => name === slug)?.[1];

  if (!marker) {
    throw new Error(`No controlled-failure expectation for ${slug}.`);
  }

  return marker;
}

export async function matchOutcome(
  daemon: OwnedDaemon,
  snapshot: RunSnapshotView,
  marker: string | null,
) {
  if (marker === null) {
    return snapshot.run.status === "succeeded";
  }

  if (snapshot.run.status !== "failed" || !snapshot.run.error.includes(marker)) {
    return false;
  }

  const revision = await daemon.request(`/runs/${snapshot.run.id}/graph`, routes.runGraph.response);
  const label = failureLabels.get(snapshot.run.slug);

  const definitions = revision.graph.nodes.filter((node) =>
    label === undefined
      ? node.kind === "fail" && JSON.stringify(node.message).includes(marker)
      : node.kind === "code" && node.label === label,
  );

  const failed = snapshot.nodeRuns.filter((node) => node.status === "failed");

  // Fixture failures share execution error codes, so frozen text and node identity distinguish their cause.
  return (
    failed.some((node) => definitions.some((definition) => definition.id === node.key.nodeId)) &&
    failed.every((node) => node.error.code === "execution" && node.error.message.includes(marker))
  );
}
