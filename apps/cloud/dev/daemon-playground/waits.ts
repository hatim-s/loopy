import { isDeepStrictEqual } from "node:util";
import { isTerminalRun, type RunSnapshotView, routes } from "@loopy/contract";
import { until } from "../shared/poll";
import { receiptInventory } from "./capture";
import type { OwnedDaemon } from "./daemon";
import { approves, holdMs } from "./plan";

export function waitSnapshot(
  daemon: OwnedDaemon,
  id: string,
  accept: (snapshot: RunSnapshotView) => boolean,
) {
  return until(() => daemon.request(`/runs/${id}`, routes.run.response), accept, {
    timeoutMs: 90_000,
    intervalMs: 200,
    timeout: () => new Error(`Run ${id} did not reach the requested state within ninety seconds.`),
  });
}

export function waitTerminal(daemon: OwnedDaemon, id: string) {
  return waitSnapshot(daemon, id, (snapshot) => isTerminalRun(snapshot.run.status));
}

export async function restartWhileWaiting(daemon: OwnedDaemon, snapshot: RunSnapshotView) {
  const id = snapshot.run.id;
  const before = await receiptInventory(id);

  if (
    before.length === 0 ||
    before.some((receipt) => receipt.kind !== "finished") ||
    snapshot.nodeRuns.some((node) => node.status === "running")
  ) {
    throw new Error(
      "Restart proof requires at least one finished effect receipt and no unfinished execution.",
    );
  }

  const singleton = await daemon.singletonProbe();

  if (!singleton.rejected) {
    throw new Error("Second daemon unexpectedly accepted the same home.");
  }

  await daemon.stop("SIGKILL");
  await daemon.start();
  const after = await daemon.request(`/runs/${id}`, routes.run.response);
  const receipts = await receiptInventory(id);
  const hookPreserved = after.run.waitingOn?.token === snapshot.run.waitingOn?.token;
  const receiptsUnchanged = isDeepStrictEqual(before, receipts);

  if (!hookPreserved || !receiptsUnchanged || after.run.status !== "suspended") {
    throw new Error("Restart changed the suspended wait or its completed execution receipts.");
  }

  return {
    runId: id,
    singleton,
    hookPreserved,
    receiptsUnchanged,
    before,
    after: receipts,
    statusBefore: snapshot.run.status,
    statusAfter: after.run.status,
    beforeNodes: snapshot.nodeRuns,
    afterNodes: after.nodeRuns,
    claimFencing:
      "Not exercised: singleton exclusion and waiting-state restart do not prove stale per-run owner rejection.",
  };
}

export async function holdApproval(daemon: OwnedDaemon, waiting: RunSnapshotView, ordinal: number) {
  const id = waiting.run.id;
  const approved = approves(ordinal);
  const observed = Date.now();
  const target = observed + holdMs(ordinal);

  while (Date.now() < target) {
    await Bun.sleep(Math.min(250, target - Date.now()));
  }

  const stillWaiting = await daemon.request(`/runs/${id}`, routes.run.response);

  if (!stillWaiting.run.waitingOn) {
    throw new Error("Approval stopped waiting before this driver resolved it.");
  }

  await daemon.request(`/runs/${id}/hooks/approval`, routes.resolveNamedHook.response, {
    payload: { approved },
  });

  return {
    observedAt: new Date(observed).toISOString(),
    resolvedAt: new Date().toISOString(),
    heldMs: Date.now() - observed,
    approved,
  };
}
