import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PlaygroundClient } from "./client.js";
import { atomic, root, state } from "./config.js";
import { guard } from "./guard.js";
import type { Admission, Group } from "./journal.js";
import { catalog } from "./repository.js";
import { execute } from "./run.js";

export async function cohort(group: Group, phase: Admission["phase"] = "primary") {
  const client = await PlaygroundClient.open();

  if (phase === "primary") {
    const gate = await Bun.file(resolve(state, "load-enabled.json")).json();

    if (gate.batch !== client.settings.batch) {
      throw new Error("Load gate batch differs from persistent config.");
    }
  }

  await mkdir(resolve(state, "cohorts"), { recursive: true });

  const summaryPath = resolve(
    root,
    ".notes/cloud/evidence",
    `playground-driver-${phase}-${group}.json`,
  );

  if (await Bun.file(summaryPath).exists()) {
    const saved = z
      .object({ status: z.enum(["passed", "failed"]), batch: z.string() })
      .parse(await Bun.file(summaryPath).json());

    if (saved.status === "passed" && saved.batch === client.settings.batch) {
      console.log(JSON.stringify({ status: "already-complete", summaryPath }));

      return;
    }
  }

  const claim = resolve(state, "cohorts", `${phase}-${group}.lock`);
  await writeFile(claim, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), {
    flag: "wx",
    mode: 0o600,
  });
  const fixtures = await catalog(group);

  const jobs =
    phase === "preflight"
      ? [{ fixture: fixtures[0]!, ordinal: 0 }]
      : fixtures
          .flatMap((fixture) =>
            [...Array.from({ length: fixture.burst ? 100 : 25 }).keys()].map((ordinal) => ({
              fixture,
              ordinal,
            })),
          )
          .sort((a, b) => a.ordinal - b.ordinal);

  const results: Awaited<ReturnType<typeof execute>>[] = [];
  const startedAt = new Date().toISOString();
  let next = 0;
  let failed = false;

  const workers = Array.from({ length: phase === "preflight" ? 1 : 4 }, async () => {
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
          await writeFile(
            resolve(state, "ABORT"),
            `Cohort ${group} failed. Reconcile journal and API state before continuing.\n`,
          );
          throw cause;
        }
      }
    }
  });

  const outcomes = await Promise.allSettled(workers);
  await mkdir(resolve(root, ".notes/cloud/evidence"), { recursive: true });
  await atomic(summaryPath, {
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
  });

  if (failed) {
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    throw new Error(
      `Cohort stopped. ${rejected?.status === "rejected" && rejected.reason instanceof Error ? rejected.reason.message : "Inspect durable journal."}`,
    );
  }
}

export async function recover(group: Group) {
  const lock = resolve(state, "cohorts", `primary-${group}.lock`);
  const owner = z.object({ pid: z.number() }).parse(await Bun.file(lock).json());
  assertDead(owner.pid);
  await rename(lock, `${lock}.recovered-${Date.now()}`);
  const slots = resolve(state, "api-slots");

  for (const name of await readdir(slots)) {
    const slot = resolve(slots, name);

    const entry = z
      .object({ pid: z.number() })
      .parse(await Bun.file(resolve(slot, "owner.json")).json());

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
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
      return;
    }

    throw cause;
  }

  throw new Error(`Cohort owner ${pid} is alive. Refusing to recover its lock.`);
}
