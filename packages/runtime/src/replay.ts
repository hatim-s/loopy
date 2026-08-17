import type { RuntimeEvent, RuntimeSnapshot, RuntimeStore } from "./runtime.js";

export type ReplayFrame = {
  index: number;
  event: RuntimeEvent;
};

/**
 * Provider-free playback of persisted runtime events. The returned frames are
 * new objects in durable sequence order; this function never calls an
 * executor, mutates a store, or interprets an event as an instruction.
 */
export function replayEvents(events: readonly RuntimeEvent[], fromSequence = 0): ReplayFrame[] {
  if (!Number.isInteger(fromSequence) || fromSequence < 0)
    throw new Error("Replay sequence must be a non-negative integer");
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<number>();
  for (const event of ordered) {
    if (seen.has(event.sequence))
      throw new Error(`Replay contains duplicate sequence ${event.sequence}`);
    seen.add(event.sequence);
  }
  return ordered
    .filter((event) => event.sequence >= fromSequence)
    .map((event, index) => ({
      index,
      event: { ...event, payload: event.payload ? { ...event.payload } : undefined },
    }));
}

export async function replayRun(
  store: RuntimeStore,
  runId: string,
  fromSequence = 0,
): Promise<{ snapshot: RuntimeSnapshot; frames: ReplayFrame[] }> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const [attempts, events] = await Promise.all([
    store.listAttempts(runId),
    store.listEvents(runId),
  ]);
  const approvals = [];
  for (const attempt of attempts) {
    const approval = await store.getApproval(runId, attempt.nodeId);
    if (approval) approvals.push(approval);
  }
  const snapshot = { run, attempts, events, approvals } as RuntimeSnapshot;
  return { snapshot, frames: replayEvents(events, fromSequence) };
}
