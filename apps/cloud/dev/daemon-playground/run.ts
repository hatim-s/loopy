import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTerminalRun, type RunView, routes } from "@loopy/contract";
import { errorMessage } from "@loopy/core";
import { readDaemonFile } from "@loopy/runtime/local";
import { Schema } from "effect";
import { backupClosedDatabase } from "./backup";
import { capture } from "./capture";
import { home, source, state, writeEvidence } from "./config";
import { OwnedDaemon } from "./daemon";
import { expectedFailure, matchOutcome } from "./outcomes";
import { DAEMON, loadPlan, PLANNED_RUNS, runInput } from "./plan";
import { frozenHash, selections } from "./prepare";
import { holdApproval, restartWhileWaiting, waitSnapshot, waitTerminal } from "./waits";

// The manifest holds more preflight fields than the load needs.
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({ sourceHash: Schema.String, plannedRuns: Schema.Literal(PLANNED_RUNS) }),
);

export async function run() {
  if (!process.argv.includes("--root-load-gate")) {
    throw new Error(
      `The ${PLANNED_RUNS}-run load requires --root-load-gate after explicit root authorization.`,
    );
  }

  const manifest = decodeManifest(JSON.parse(await readFile(join(state, "manifest.json"), "utf8")));

  if (manifest.sourceHash !== (await frozenHash(source))) {
    throw new Error("Frozen daemon source changed after preflight.");
  }

  const plan = loadPlan(await selections());

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

      const input = runInput(ordinal);

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
        (snapshot) => snapshot.run.waitingOn !== null || isTerminalRun(snapshot.run.status),
      );

      let hold: Awaited<ReturnType<typeof holdApproval>> | null = null;

      if (first.run.waitingOn) {
        // The first approval wait doubles as the one restart proof for the whole load.
        restartProof ??= await restartWhileWaiting(daemon, first);
        hold = await holdApproval(daemon, first, ordinal);
      }

      const final = await waitTerminal(daemon, admitted.id);

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
        hold,
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
        `${records.length}/${PLANNED_RUNS} ${entry.slug} #${ordinal} ${final.run.status} expected=${expectedStatus} attempts=${captured.attemptCount}`,
      );
    }

    const census = await daemon.request("/runs?limit=200", routes.runs.response);
    apiRuns = census.map(({ id, status }) => ({ id, status }));
  } catch (cause) {
    failure = errorMessage(cause);
    throw cause;
  } finally {
    await daemon.stop();

    const backup = await backupClosedDatabase(apiRuns)
      .then((result) => ({ status: "captured" as const, ...result }))
      .catch((cause: unknown) => ({ status: "failed" as const, error: errorMessage(cause) }));

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
        daemonConcurrency: DAEMON.concurrency,
        leaseMs: DAEMON.leaseMs,
        host: process.platform,
        cloudComparison:
          "Host Bun sandbox workers and local SQLite differ from Cloudflare DO scheduling and Docker resource caps. Latencies are not hardware-equivalent.",
      },
    });

    // A run failure is already propagating; otherwise a missing backup must fail the load.
    if (failure === null && backup.status === "failed") {
      throw new Error(`Closed diagnostic backup failed: ${backup.error}`);
    }
  }
}

if (import.meta.main) {
  await run();
}
