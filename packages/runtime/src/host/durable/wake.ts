import { executionKeyString, type NodeRun } from "@loopy/core";
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

  const deadlines = nodes.flatMap((node) => {
    if (node.status === "retrying" || node.status === "rate_limited") {
      return [node.nextRetryAt];
    }

    return (node.status === "waiting" || node.status === "sleeping") && node.wakeAt !== null
      ? [node.wakeAt]
      : [];
  });

  const heartbeatAt = now + leaseRenewalMs(leaseMs);
  const checkAt = nodes.some((node) => node.status === "running") ? now + pollMs : heartbeatAt;

  return new Date(
    Math.min(
      ready ? now : checkAt,
      heartbeatAt,
      ...deadlines.map((deadline) => Date.parse(deadline)),
    ),
  ).toISOString();
}
