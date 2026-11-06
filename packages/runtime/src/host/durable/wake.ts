import { executionKeyString, type NodeRun } from "@loopy/core";
import type { DurableWork } from "./work";

export function durableWakeAt(options: {
  nodes: NodeRun[];
  remaining: Iterable<DurableWork>;
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

  // Retry delays keep the run leased, so even distant deadlines need a heartbeat alarm.
  const heartbeatAt = now + Math.max(1, Math.floor(leaseMs / 3));
  const checkAt = nodes.some((node) => node.status === "running") ? now + pollMs : heartbeatAt;

  return new Date(
    Math.min(
      ready ? now : checkAt,
      heartbeatAt,
      ...deadlines.map((deadline) => Date.parse(deadline)),
    ),
  ).toISOString();
}
