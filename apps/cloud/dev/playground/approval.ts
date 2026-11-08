import { isDeepStrictEqual } from "node:util";
import { type RunSnapshotView, routes } from "@loopy/contract";
import type { PlaygroundClient } from "./client";
import { state } from "./config";
import { atomic } from "./files";
import { guard } from "./guard";
import { type Admission, event, type Progress } from "./journal";

export async function updateApproval(options: {
  client: PlaygroundClient;
  admission: Admission;
  runId: string;
  snapshot: RunSnapshotView;
  progress: Progress;
  path: string;
}): Promise<Progress> {
  const { client, admission, runId, snapshot, path } = options;
  const { group, phase } = admission;
  const holdMs = (10 + ((admission.input.ordinal * 7) % 36)) * 1000;
  let progress = options.progress;

  const save = async (next: Progress) => {
    progress = next;
    atomic(path, progress);
  };

  const pending = progress.wait;

  if (pending && pending.resolvedAt === null && progress.approvalIntentAt) {
    const hook = snapshot.hooks.find((entry) => entry.name === pending.hook && entry.resolvedAt);

    if (hook?.resolvedAt && isDeepStrictEqual(hook.payload, { approved: true })) {
      await save({ ...progress, wait: { ...pending, resolvedAt: hook.resolvedAt } });
      await event(state, group, {
        kind: "approval-reconciled",
        runId,
        phase,
        resolvedAt: hook.resolvedAt,
      });
    }
  }

  const waiting = snapshot.run.waitingOn;

  if (waiting && progress.wait === null) {
    const wait = {
      hook: waiting.hook,
      observedAt: new Date().toISOString(),
      dueAt: Date.now() + holdMs,
      resolvedAt: null,
    };

    await save({ ...progress, wait });
    await event(state, group, { kind: "wait-observed", runId, phase, delayMs: holdMs, ...wait });
  }

  const wait = progress.wait;

  if (waiting && wait && wait.resolvedAt === null && Date.now() >= wait.dueAt) {
    await guard();

    if (progress.approvalIntentAt !== null) {
      throw new Error(
        "Approval admission is ambiguous. Inspect hook history before retrying resolution.",
      );
    }

    // Persist the intent before resolving so a crash never resolves the same hook twice.
    await save({ ...progress, approvalIntentAt: new Date().toISOString() });
    await event(state, group, { kind: "approval-intent", runId, phase, hook: waiting.hook });
    await client.call(routes.resolveNamedHook, {
      params: { id: runId, name: waiting.hook },
      body: { payload: { approved: true } },
    });
    const resolvedAt = new Date().toISOString();
    await save({ ...progress, wait: { ...wait, resolvedAt } });
    await event(state, group, {
      kind: "approval-resolved",
      runId,
      phase,
      observedAt: wait.observedAt,
      delayMs: Date.now() - Date.parse(wait.observedAt),
      resolvedAt,
    });
  }

  return progress;
}
