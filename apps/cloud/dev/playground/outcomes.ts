import { type RunSnapshotView, routes } from "@loopy/contract";
import type { PlaygroundClient } from "./client";
import type { Admission } from "./journal";

const failures = new Map([
  [
    "playground-a-format-report",
    {
      kind: "fail",
      label: null,
      marker: "Controlled format check failure requested by fixture input.",
    },
  ],
  [
    "playground-a-lint-report",
    {
      kind: "fail",
      label: null,
      marker: "Controlled lint gate failure requested by fixture input.",
    },
  ],
  [
    "playground-a-dependency-audit",
    {
      kind: "fail",
      label: null,
      marker: "Controlled dependency policy failure requested by fixture input.",
    },
  ],
  [
    "playground-a-generated-docs",
    {
      kind: "fail",
      label: null,
      marker: "Controlled generated documentation failure requested by fixture input.",
    },
  ],
  [
    "playground-b-test-matrix",
    { kind: "fail", label: null, marker: "Controlled test matrix policy failure" },
  ],
  [
    "playground-b-parallel-build",
    { kind: "fail", label: null, marker: "Controlled build size policy failure" },
  ],
  [
    "playground-b-retry-marker",
    {
      kind: "code",
      label: "retry-update",
      marker: "Controlled CI retry failure. The retry marker is safe to inspect.",
    },
  ],
  [
    "playground-b-log-audit",
    {
      kind: "code",
      label: "audit",
      marker: "Controlled audit policy failure after bounded evidence logs.",
    },
  ],
  [
    "playground-c-sleep-resume",
    {
      kind: "code",
      label: "resume-report",
      marker: "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
    },
  ],
  [
    "playground-c-repository-validation",
    {
      kind: "code",
      label: "repository-report",
      marker: "PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.",
    },
  ],
]);

export async function classification(
  client: PlaygroundClient,
  admission: Admission,
  snapshot: RunSnapshotView,
) {
  if (admission.expected === "succeeded") {
    return snapshot.run.status === "succeeded" ? ("success" as const) : null;
  }

  const rule = failures.get(admission.slug);

  if (!rule || snapshot.run.status !== "failed" || !snapshot.run.error.includes(rule.marker)) {
    return null;
  }

  const revision = await client.json(routes.runGraph.response, `/runs/${snapshot.run.id}/graph`);

  const nodes = revision.graph.nodes.filter(
    (node) =>
      node.kind === rule.kind &&
      (rule.label === null
        ? node.kind === "fail" && JSON.stringify(node.message).includes(rule.marker)
        : node.label === rule.label),
  );

  const failed = snapshot.nodeRuns.filter((node) => node.status === "failed");

  const expectedNode = failed.some((node) =>
    nodes.some((definition) => definition.id === node.key.nodeId),
  );

  const controlled =
    failed.length > 0 &&
    failed.every(
      (node) => node.error.code === "execution" && node.error.message.includes(rule.marker),
    );

  return expectedNode && controlled ? ("controlled-failure" as const) : null;
}
