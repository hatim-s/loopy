import { executionKeyString, type NodeRun } from "@loopy/core";
import { nextDeadline } from "@loopy/core/engine";
import { leaseRenewalMs } from "../heartbeat";
import type { HostWork } from "../turn";

export function durableWakeAt(options: {
  nodes: NodeRun[];
  remaining: Iterable<HostWork>;
  now: number;
  pollMs: number;
  leaseMs: number;
}): string {
  const { nodes, remaining, now, pollMs, leaseMs } = options;
  const byKey = new Map(nodes.map((node) => [executionKeyString(node.key), node]));

  const ready = [...remaining].some((work) => {
    const node = byKey.get(executionKeyString(work.executionKey));

    return (
      node?.status === "running" &&
      (work.kind === "sample" || (node.attempt === work.attempt && node.receipt === "none"))
    );
  });

  const deadline = nextDeadline(nodes);

  const heartbeatAt = now + leaseRenewalMs(leaseMs);
  const checkAt = nodes.some((node) => node.status === "running") ? now + pollMs : heartbeatAt;

  return new Date(
    Math.min(
      ready ? now : checkAt,
      heartbeatAt,
      deadline === null ? Number.POSITIVE_INFINITY : Date.parse(deadline),
    ),
  ).toISOString();
}
