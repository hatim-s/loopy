import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type RunView, routes } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { z } from "zod";
import { backupClosedDatabase } from "./backup";
import { capture } from "./capture";
import { home, source, state, writeEvidence } from "./config";
import { OwnedDaemon } from "./daemon";
import { expectedFailure, matchOutcome } from "./outcomes";
import { frozenHash, selections } from "./prepare";
import type { restartWhileWaiting } from "./waits";
import { holdApproval, terminal, waitSnapshot } from "./waits";

const manifestSchema = z.object({ sourceHash: z.string(), plannedRuns: z.literal(45) });

async function loadPlan() {
  const entries = await selections();
  const approval = entries.find((entry) => entry.approval);

  if (!approval) {
    throw new Error("The selected catalog has no approval workflow.");
  }

  const plan = [
    { entry: approval, ordinal: 1 },
    ...entries
      .flatMap((entry) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((ordinal) => ({ entry, ordinal })))
      .filter(({ entry, ordinal }) => entry.slug !== approval.slug || ordinal !== 1),
  ];

  return plan;
}

export async function run() {
  if (!process.argv.includes("--root-load-gate")) {
    throw new Error("The 45-run load requires --root-load-gate after explicit root authorization.");
  }

  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(state, "manifest.json"), "utf8")),
  );

  if (manifest.sourceHash !== (await frozenHash(source))) {
    throw new Error("Frozen daemon source changed after preflight.");
  }

  const plan = await loadPlan();

  await writeFile(
    join(state, "load-started.json"),
    JSON.stringify({ startedAt: new Date().toISOString(), plannedRuns: plan.length }),
    { flag: "wx", mode: 0o600 },
  );

  const daemon = new OwnedDaemon();
  const records = [];
  const startedAt = new Date().toISOString();
  let restartProof: Awaited<ReturnType<typeof restartWhileWaiting>> | null = null;
  let failure: string | null = null;
  let apiRuns: Pick<RunView, "id" | "status">[] | null = null;

  try {
    await daemon.start();

    for (const { entry, ordinal } of plan) {
      // Each workflow is serial because its repository paths are fixed by the frozen source.
      await rm(join(entry.workspace, "loopies-playground"), { recursive: true, force: true });

      const input = {
        batch: "playground-daemon-45",
        ordinal,
        fail: ordinal === 5,
        items: [3, 7, 11, ordinal],
      };

      const marker = expectedFailure(entry.slug, ordinal);
      const expectedStatus = marker === null ? "succeeded" : "failed";
      const intentAt = new Date().toISOString();
      const beforePost = performance.now();

      const admitted = await daemon.request(
        `/loopies/${entry.slug}/runs`,
        routes.startRun.response,
        { workspace: entry.workspace, input },
      );

      const admissionMs = performance.now() - beforePost;
      const admittedAt = new Date().toISOString();
      await writeEvidence("-progress", {
        startedAt,
        admitted: records.length + 1,
        completed: records.length,
        activeRunId: admitted.id,
        slug: entry.slug,
      });

      const first = await waitSnapshot(
        daemon,
        admitted.id,
        (snapshot) => snapshot.run.waitingOn !== null || terminal.has(snapshot.run.status),
      );

      const held = await holdApproval({ daemon, first, ordinal, restartProof });
      restartProof = held.restartProof;

      const final = await waitSnapshot(daemon, admitted.id, (snapshot) =>
        terminal.has(snapshot.run.status),
      );

      const captured = await capture(daemon, final, entry.workspace);

      const record = {
        slug: entry.slug,
        input,
        expectedStatus,
        expectedFailure: marker,
        intentAt,
        admittedAt,
        admissionMs,
        terminalAt: new Date().toISOString(),
        observedMs: Date.now() - Date.parse(intentAt),
        hold: held.hold,
        matched: await matchOutcome(daemon, final, marker),
        ...captured,
      };

      records.push(record);
      await writeEvidence("", { startedAt, completed: records.length, records, restartProof });

      if (!record.matched) {
        throw new Error(
          `Unexpected outcome for ${entry.slug} run ${final.run.id}. Admissions stopped; inspect retained evidence.`,
        );
      }

      console.log(
        `${records.length}/45 ${entry.slug} #${ordinal} ${final.run.status} expected=${expectedStatus} attempts=${captured.attemptCount}`,
      );
    }

    const census = await daemon.request("/runs?limit=200", routes.runs.response);
    apiRuns = census.map(({ id, status }) => ({ id, status }));
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  } finally {
    await daemon.stop();

    const backup = await backupClosedDatabase(apiRuns)
      .then((result) => ({ status: "captured" as const, ...result }))
      .catch((cause: unknown) => ({
        status: "failed" as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }));

    await writeEvidence("", {
      startedAt,
      endedAt: new Date().toISOString(),
      completed: records.length,
      failure,
      matched: records.filter((record) => record.matched).length,
      records,
      apiRuns,
      restartProof,
      starts: daemon.starts,
      cleanup: { daemonStopped: readDaemonFile(home) === undefined, dataRetained: true, backup },
      limits: {
        runConcurrency: 1,
        daemonConcurrency: 4,
        leaseMs: 2000,
        host: process.platform,
        cloudComparison:
          "Host Bun sandbox workers and local SQLite differ from Cloudflare DO scheduling and Docker resource caps. Latencies are not hardware-equivalent.",
      },
    });
  }
}

if (import.meta.main) {
  await run();
}
