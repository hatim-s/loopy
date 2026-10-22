import { type RunSnapshotView, routes } from "../../packages/loopy/src/contract/index.js";
import type { PlaygroundClient } from "./client.js";
import { atomic } from "./config.js";
import { guard } from "./guard.js";
import { type Admission, event, type Progress } from "./journal.js";

export async function updateApproval(options: {
  client: PlaygroundClient;
  admission: Admission;
  snapshot: RunSnapshotView;
  progress: Progress;
  path: string;
}) {
  const { client, admission, snapshot, progress, path: progressPath } = options;
  const { group, phase, runId } = admission;
  const holdMs = (10 + ((admission.input.ordinal * 7) % 36)) * 1000;
  let wait = progress.wait;

  if (wait && wait.resolvedAt === null && progress.approvalIntentAt) {
    const hook = snapshot.hooks.find((entry) => entry.name === wait?.hook && entry.resolvedAt);

    if (hook?.resolvedAt && JSON.stringify(hook.payload) === JSON.stringify({ approved: true })) {
      wait.resolvedAt = hook.resolvedAt;
      progress.wait = wait;
      await atomic(progressPath, progress);
      await event(group, {
        kind: "approval-reconciled",
        runId,
        phase,
        resolvedAt: hook.resolvedAt,
      });
    }
  }

  const waiting = snapshot.run.waitingOn;

  if (waiting && wait === null) {
    wait = {
      hook: waiting.hook,
      observedAt: new Date().toISOString(),
      dueAt: Date.now() + holdMs,
      resolvedAt: null,
    };
    progress.wait = wait;
    await atomic(progressPath, progress);
    await event(group, { kind: "wait-observed", runId, phase, delayMs: holdMs, ...wait });
  }

  if (waiting && wait && wait.resolvedAt === null && Date.now() >= wait.dueAt) {
    await guard();

    if (progress.approvalIntentAt !== null) {
      throw new Error(
        "Approval admission is ambiguous. Inspect hook history before retrying resolution.",
      );
    }

    progress.approvalIntentAt = new Date().toISOString();
    await atomic(progressPath, progress);
    await event(group, { kind: "approval-intent", runId, phase, hook: waiting.hook });
    await client.json(
      routes.resolveNamedHook.response,
      `/runs/${runId}/hooks/${encodeURIComponent(waiting.hook)}`,
      { payload: { approved: true } },
    );
    wait.resolvedAt = new Date().toISOString();
    progress.wait = wait;
    await atomic(progressPath, progress);
    await event(group, {
      kind: "approval-resolved",
      runId,
      phase,
      observedAt: wait.observedAt,
      delayMs: Date.now() - Date.parse(wait.observedAt),
      resolvedAt: wait.resolvedAt,
    });
  }
}
