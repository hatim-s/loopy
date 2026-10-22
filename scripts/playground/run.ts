import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { routes } from "../../packages/loopy/src/contract/index.js";
import { updateApproval } from "./approval.js";
import { materialize, verifySaved } from "./artifacts.js";
import type { PlaygroundClient } from "./client.js";
import { atomic, state } from "./config.js";
import { guard } from "./guard.js";
import {
  type Admission,
  admissionSchema,
  event,
  type Group,
  type Progress,
  progressSchema,
  record,
  resultSchema,
} from "./journal.js";
import { classification } from "./outcomes.js";
import { type CatalogEntry } from "./repository.js";

export type Job = { fixture: CatalogEntry; ordinal: number };

async function admit(client: PlaygroundClient, group: Group, job: Job, phase: Admission["phase"]) {
  const { fixture, ordinal } = job;
  const directory = resolve(state, "journal", phase, group);
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${fixture.slug}-${ordinal}.json`);
  let admission: Admission;

  if (await Bun.file(file).exists()) {
    admission = admissionSchema.parse(await Bun.file(file).json());

    if (admission.runId === null) {
      throw new Error(
        `Ambiguous admission ${file}. Reconcile via API input identity before assigning a run ID; never resubmit blindly.`,
      );
    }
  } else {
    await guard();
    const fail = phase === "primary" && !fixture.approval && ordinal % 6 === 5;
    admission = {
      slug: fixture.slug,
      group,
      phase,
      input: {
        batch: phase === "preflight" ? `${client.settings.batch}-preflight` : client.settings.batch,
        ordinal,
        fail,
        items: [(ordinal % 5) + 1, (ordinal % 7) + 2],
      },
      expected: fail ? "failed" : "succeeded",
      intentAt: new Date().toISOString(),
      admittedAt: null,
      runId: null,
    };
    await writeFile(file, `${JSON.stringify(admission, null, 2)}\n`, { flag: "wx", mode: 0o600 });

    const run = await client.json(routes.startRun.response, `/loopies/${fixture.slug}/runs`, {
      input: admission.input,
      workspace: "playground",
    });

    admission = { ...admission, runId: run.id, admittedAt: new Date().toISOString() };
    await record(file, admission);
    await event(group, { kind: "admitted", ...admission });
  }

  return { admission, file };
}

export async function execute(
  client: PlaygroundClient,
  group: Group,
  job: Job,
  phase: Admission["phase"],
) {
  const { fixture } = job;
  const { admission, file } = await admit(client, group, job, phase);
  const progressPath = `${file}.progress.json`;

  const progress: Progress = (await Bun.file(progressPath).exists())
    ? progressSchema.parse(await Bun.file(progressPath).json())
    : { wait: null, approvalIntentAt: null, result: null };

  if (progress.result) {
    if (progress.result.artifact) {
      await verifySaved(progress.result.artifact, admission.input, fixture.slug);
    }

    return progress.result;
  }

  const runId = admission.runId;
  const deadline = Date.now() + 40 * 60_000;

  while (Date.now() < deadline) {
    const snapshot = await client.json(routes.run.response, `/runs/${runId}`);

    await updateApproval({ client, admission, snapshot, progress, path: progressPath });

    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) {
      const outcome = await classification(client, admission, snapshot);

      const unexpected =
        outcome === null ||
        (fixture.approval && (progress.wait === null || progress.wait.resolvedAt === null));

      await event(group, {
        kind: "terminal",
        runId,
        slug: fixture.slug,
        phase,
        expected: admission.expected,
        actual: snapshot.run.status,
        unexpected,
        classification: outcome,
        error: snapshot.run.status === "failed" ? snapshot.run.error : null,
        wait: progress.wait,
        intentAt: admission.intentAt,
        admittedAt: admission.admittedAt,
        terminalAt: snapshot.run.updatedAt,
      });

      if (unexpected) {
        await writeFile(
          resolve(state, "ABORT"),
          `Unexpected ${snapshot.run.status} for ${fixture.slug} ${runId}; expected ${admission.expected}.\n`,
        );
        throw new Error(
          `Unexpected terminal outcome for ${runId}. Admission guard set; inspect journal and run snapshot.`,
        );
      }

      const artifact = await materialize(client, snapshot, fixture, admission.input);
      await event(group, { kind: "artifact", runId, phase, artifact });

      const result = resultSchema.parse({
        runId,
        slug: fixture.slug,
        expected: admission.expected,
        actual: snapshot.run.status,
        classification: outcome,
        wait: progress.wait,
        artifact,
      });

      progress.result = result;
      await atomic(progressPath, progress);

      return result;
    }

    await Bun.sleep(1000);
  }

  throw new Error(
    `Run ${runId} exceeded driver observation deadline. Its durable run remains available.`,
  );
}
