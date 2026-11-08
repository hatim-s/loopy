import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, encodeBoundary } from "@loopy/contract";
import { errnoCode, errorMessage } from "@loopy/core";
import { Schema } from "effect";
import { PlaygroundClient } from "./client";
import { evidence, state } from "./config";
import { atomic } from "./files";
import { guard } from "./guard";
import {
  type Group,
  gatePath,
  gateSchema,
  type Phase,
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

  const claim = resolve(state, "cohorts", `${phase}-${group}.lock`);
  await writeFile(claim, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
    flag: "wx",
    mode: 0o600,
  });
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
  await atomic(
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

export async function recover(group: Group) {
  const lock = resolve(state, "cohorts", `primary-${group}.lock`);
  const owner = decodeOwner(await Bun.file(lock).json());
  assertDead(owner.pid);
  await rename(lock, `${lock}.recovered-${Date.now()}`);
  const slots = resolve(state, "api-slots");

  for (const name of await readdir(slots)) {
    const slot = resolve(slots, name);
    const entry = decodeOwner(await Bun.file(resolve(slot, "owner.json")).json());

    try {
      assertDead(entry.pid);
    } catch {
      continue;
    }

    await rm(slot, { recursive: true });
  }

  console.log(
    "Recovered dead cohort lock and dead API slots. ABORT remains set. Reconcile ambiguous admission and approval intents, then the parent may remove ABORT and rerun the same cohort.",
  );
}

function assertDead(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (cause) {
    if (errnoCode(cause) === "ESRCH") {
      return;
    }

    throw cause;
  }

  throw new Error(`Cohort owner ${pid} is alive. Refusing to recover its lock.`);
}
