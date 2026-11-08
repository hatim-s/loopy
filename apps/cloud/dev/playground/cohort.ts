import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, encodeBoundary } from "@loopy/contract";
import { errorMessage } from "@loopy/core";
import { processAlive } from "@loopy/runtime/os";
import { Schema } from "effect";
import { createOnce } from "../shared/fs";
import { PlaygroundClient } from "./client";
import { evidence, state } from "./config";
import { atomic } from "./files";
import { guard } from "./guard";
import {
  type Group,
  gatePath,
  gateSchema,
  type Phase,
  phases,
  readSummary,
  summaryPath,
  summarySchema,
  writeAbort,
} from "./journal";
import { CONCURRENCY, cohortJobs } from "./plan";
import { catalog } from "./repository";
import { execute } from "./run";

const ownerSchema = Schema.Struct({ pid: Schema.Number });

// Lock owner files may carry extra diagnostics; only the PID decides liveness.
const decodeOwner = Schema.decodeUnknownSync(ownerSchema, { onExcessProperty: "ignore" });

export async function cohort(group: Group, phase: Phase = "primary") {
  const client = await PlaygroundClient.open();

  if (phase === "primary") {
    const gate = decodeBoundary(gateSchema)(await Bun.file(gatePath(state)).json());

    if (gate.batch !== client.settings.batch) {
      throw new Error("Load gate batch differs from persistent config.");
    }
  }

  await mkdir(resolve(state, "cohorts"), { recursive: true });

  const summary = summaryPath(evidence, phase, group);

  if (await Bun.file(summary).exists()) {
    const saved = await readSummary(summary);

    if (saved.status === "passed" && saved.batch === client.settings.batch) {
      console.log(JSON.stringify({ status: "already-complete", summaryPath: summary }));

      return;
    }
  }

  const claim = claimPath(phase, group);
  createOnce(
    claim,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    0o600,
    `Cohort ${phase}/${group} is already claimed at ${claim}. Remove the claim only after its driver has stopped.`,
  );
  const jobs = cohortJobs(phase, await catalog(group));
  const results: Awaited<ReturnType<typeof execute>>[] = [];
  const startedAt = new Date().toISOString();
  let next = 0;
  let failed = false;

  const workers = Array.from({ length: phase === "preflight" ? 1 : CONCURRENCY }, async () => {
    while (!failed && next < jobs.length) {
      const job = jobs[next++];

      if (job) {
        try {
          await guard();
          results.push(await execute(client, group, job, phase));
          console.log(
            JSON.stringify({
              group,
              phase,
              completed: results.length,
              planned: jobs.length,
              latest: results.at(-1)?.runId,
            }),
          );
        } catch (cause) {
          failed = true;
          await writeAbort(
            state,
            `Cohort ${group} failed. Reconcile journal and API state before continuing.`,
          );
          throw cause;
        }
      }
    }
  });

  const outcomes = await Promise.allSettled(workers);
  await mkdir(evidence, { recursive: true });
  atomic(
    summary,
    encodeBoundary(summarySchema)({
      status: failed ? "failed" : "passed",
      scope: "local-wrangler-docker",
      batch: client.settings.batch,
      group,
      phase,
      startedAt,
      endedAt: new Date().toISOString(),
      planned: jobs.length,
      completed: results.length,
      results,
    }),
  );

  if (failed) {
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    throw new Error(
      `Cohort stopped. ${rejected?.status === "rejected" ? errorMessage(rejected.reason) : "Inspect durable journal."}`,
    );
  }
}

// A claim outlives a failed cohort on purpose, so a rerun cannot overwrite that cohort's evidence.
function claimPath(phase: Phase, group: Group) {
  return resolve(state, "cohorts", `${phase}-${group}.lock`);
}

export async function recover(group: Group) {
  const claims: string[] = [];

  for (const phase of phases) {
    const claim = Bun.file(claimPath(phase, group));

    if (await claim.exists()) {
      const owner = decodeOwner(await claim.json());

      if (processAlive(owner.pid)) {
        throw new Error(`Cohort owner ${owner.pid} is alive. Refusing to recover its claim.`);
      }

      claims.push(claimPath(phase, group));
    }
  }

  for (const claim of claims) {
    await rename(claim, `${claim}.recovered-${Date.now()}`);
  }

  console.log(
    "Recovered dead cohort claims. API slots and the pressure lock reclaim dead owners on their own. ABORT remains set. Reconcile ambiguous admission and approval intents, then the parent may remove ABORT and rerun the same cohort.",
  );
}
