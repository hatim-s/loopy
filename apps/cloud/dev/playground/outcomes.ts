import { type RunSnapshotView, routes } from "@loopy/contract";
import type { PlaygroundClient } from "./client";
import type { Admission } from "./journal";

type ControlledFailure = { label: string | null; marker: string };

type RunGraph = typeof routes.runGraph.response.Type;

// A null label means the failure comes from a `fail` node whose message carries the marker.
export const controlledFailures = {
  "playground-a-format-report": {
    label: null,
    marker: "Controlled format check failure requested by fixture input.",
  },
  "playground-a-lint-report": {
    label: null,
    marker: "Controlled lint gate failure requested by fixture input.",
  },
  "playground-a-dependency-audit": {
    label: null,
    marker: "Controlled dependency policy failure requested by fixture input.",
  },
  "playground-a-generated-docs": {
    label: null,
    marker: "Controlled generated documentation failure requested by fixture input.",
  },
  "playground-b-test-matrix": { label: null, marker: "Controlled test matrix policy failure" },
  "playground-b-parallel-build": { label: null, marker: "Controlled build size policy failure" },
  "playground-b-retry-marker": {
    label: "retry-update",
    marker: "Controlled CI retry failure. The retry marker is safe to inspect.",
  },
  "playground-b-log-audit": {
    label: "audit",
    marker: "Controlled audit policy failure after bounded evidence logs.",
  },
  "playground-c-sleep-resume": {
    label: "resume-report",
    marker: "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
  },
  "playground-c-repository-validation": {
    label: "repository-report",
    marker: "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
  },
  "playground-c-security-review": {
    label: "publish-report",
    marker: "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
  },
} as const satisfies Record<string, ControlledFailure>;

export function controlledFailure(slug: string): ControlledFailure | undefined {
  return Object.entries(controlledFailures).find(([name]) => name === slug)?.[1];
}

// Fixture failures share execution error codes, so frozen text and node identity distinguish their cause.
export function matchesControlledFailure(
  rule: ControlledFailure,
  snapshot: RunSnapshotView,
  graph: RunGraph,
) {
  if (snapshot.run.status !== "failed" || !snapshot.run.error.includes(rule.marker)) {
    return false;
  }

  const definitions = graph.graph.nodes.filter((node) =>
    rule.label === null
      ? node.kind === "fail" && JSON.stringify(node.message).includes(rule.marker)
      : node.kind === "code" && node.label === rule.label,
  );

  const failed = snapshot.nodeRuns.filter((node) => node.status === "failed");

  return (
    failed.some((node) => definitions.some((definition) => definition.id === node.key.nodeId)) &&
    failed.every(
      (node) => node.error.code === "execution" && node.error.message.includes(rule.marker),
    )
  );
}

export async function classification(
  client: PlaygroundClient,
  admission: Admission,
  snapshot: RunSnapshotView,
) {
  if (admission.expected === "succeeded") {
    return snapshot.run.status === "succeeded" ? ("success" as const) : null;
  }

  const rule = controlledFailure(admission.slug);

  if (!rule || snapshot.run.status !== "failed" || !snapshot.run.error.includes(rule.marker)) {
    return null;
  }

  const graph = await client.call(routes.runGraph, { params: { id: snapshot.run.id } });

  return matchesControlledFailure(rule, snapshot, graph) ? ("controlled-failure" as const) : null;
}
