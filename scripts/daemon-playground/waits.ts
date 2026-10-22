import { type RunSnapshotView, routes } from "../../packages/loopy/src/contract/index.ts";
import { receiptInventory } from "./capture.ts";
import type { OwnedDaemon } from "./daemon.ts";

export const terminal = new Set(["succeeded", "failed", "cancelled"]);

export async function waitSnapshot(
  daemon: OwnedDaemon,
  id: string,
  predicate: (snapshot: RunSnapshotView) => boolean,
) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    const snapshot = await daemon.request(`/runs/${id}`, routes.run.response);

    if (predicate(snapshot)) {
      return snapshot;
    }

    await Bun.sleep(200);
  }

  throw new Error(`Run ${id} did not reach the requested state within ninety seconds.`);
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
  const receiptsUnchanged = JSON.stringify(before) === JSON.stringify(receipts);

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

interface HoldOptions {
  daemon: OwnedDaemon;
  first: RunSnapshotView;
  ordinal: number;
  restartProof: Awaited<ReturnType<typeof restartWhileWaiting>> | null;
}

export async function holdApproval({ daemon, first, ordinal, restartProof }: HoldOptions) {
  const admitted = first.run;
  const approved = ordinal !== 8;
  let proof = restartProof;

  let hold: {
    observedAt: string;
    resolvedAt: string;
    heldMs: number;
    approved: boolean;
  } | null = null;

  if (first.run.waitingOn) {
    const observed = Date.now();

    if (!proof) {
      proof = await restartWhileWaiting(daemon, first);
    }

    const target = observed + 10_000 + (ordinal % 3) * 1000;

    while (Date.now() < target) {
      await Bun.sleep(Math.min(250, target - Date.now()));
    }

    const stillWaiting = await daemon.request(`/runs/${admitted.id}`, routes.run.response);

    if (!stillWaiting.run.waitingOn) {
      throw new Error("Approval stopped waiting before this driver resolved it.");
    }

    await daemon.request(`/runs/${admitted.id}/hooks/approval`, routes.resolveNamedHook.response, {
      payload: { approved },
    });
    hold = {
      observedAt: new Date(observed).toISOString(),
      resolvedAt: new Date().toISOString(),
      heldMs: Date.now() - observed,
      approved,
    };
  }

  return { hold, restartProof: proof };
}
