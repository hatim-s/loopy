import { writeFile } from "node:fs/promises";
import { decodeBoundary, routes } from "@loopy/contract";
import { updateApproval } from "./approval";
import { materialize, verifySaved } from "./artifacts";
import type { PlaygroundClient } from "./client";
import { state } from "./config";
import { atomic } from "./files";
import { guard } from "./guard";
import {
  type Admission,
  admissionPath,
  event,
  type Group,
  type Phase,
  type Progress,
  progressPath,
  progressSchema,
  readAdmission,
  recordAdmission,
  writeAbort,
} from "./journal";
import { classification } from "./outcomes";
import { failsAt, type Job } from "./plan";
import type { CatalogEntry } from "./repository";

async function admit(client: PlaygroundClient, group: Group, job: Job<CatalogEntry>, phase: Phase) {
  const { fixture, ordinal } = job;
  const file = await admissionPath(state, { phase, group, slug: fixture.slug, ordinal });

  if (await Bun.file(file).exists()) {
    const admission = await readAdmission(file);

    if (admission.runId === null) {
      throw new Error(
        `Ambiguous admission ${file}. Reconcile via API input identity before assigning a run ID; never resubmit blindly.`,
      );
    }

    return { admission, runId: admission.runId, file };
  }

  await guard();
  const fail = failsAt(phase, fixture, ordinal);

  const intent: Admission = {
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

  // The intent is durable before the request so a crash leaves an ambiguous record, never a repeat.
  await writeFile(file, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  const run = await client.call(routes.startRun, {
    params: { slug: fixture.slug },
    body: { input: { ...intent.input, items: [...intent.input.items] }, workspace: "playground" },
  });

  const admission = { ...intent, runId: run.id, admittedAt: new Date().toISOString() };
  await recordAdmission(file, admission);
  await event(state, group, { kind: "admitted", ...admission });

  return { admission, runId: run.id, file };
}

export async function execute(
  client: PlaygroundClient,
  group: Group,
  job: Job<CatalogEntry>,
  phase: Phase,
) {
  const { fixture } = job;
  const { admission, runId, file } = await admit(client, group, job, phase);
  const path = progressPath(file);

  let progress: Progress = (await Bun.file(path).exists())
    ? decodeBoundary(progressSchema)(await Bun.file(path).json())
    : { wait: null, approvalIntentAt: null, result: null };

  if (progress.result) {
    if (progress.result.artifact) {
      await verifySaved(progress.result.artifact, admission.input, fixture.slug);
    }

    return progress.result;
  }

  const deadline = Date.now() + 40 * 60_000;

  while (Date.now() < deadline) {
    const snapshot = await client.call(routes.run, { params: { id: runId } });

    progress = await updateApproval({ client, admission, runId, snapshot, progress, path });

    const actual = snapshot.run.status;

    // Spelled out so the terminal status narrows for the journal and result records.
    if (actual === "succeeded" || actual === "failed" || actual === "cancelled") {
      const outcome = await classification(client, admission, snapshot);

      const approvalMissing =
        fixture.approval && (progress.wait === null || progress.wait.resolvedAt === null);

      await event(state, group, {
        kind: "terminal",
        runId,
        slug: fixture.slug,
        phase,
        expected: admission.expected,
        actual,
        unexpected: outcome === null || actual === "cancelled" || approvalMissing,
        classification: outcome,
        error: snapshot.run.status === "failed" ? snapshot.run.error : null,
        wait: progress.wait,
        intentAt: admission.intentAt,
        admittedAt: admission.admittedAt,
        terminalAt: snapshot.run.updatedAt,
      });

      if (outcome === null || actual === "cancelled" || approvalMissing) {
        await writeAbort(
          state,
          `Unexpected ${actual} for ${fixture.slug} ${runId}; expected ${admission.expected}.`,
        );
        throw new Error(
          `Unexpected terminal outcome for ${runId}. Admission guard set; inspect journal and run snapshot.`,
        );
      }

      const artifact = await materialize(client, snapshot, fixture, admission.input);
      await event(state, group, { kind: "artifact", runId, phase, artifact });

      const result = {
        runId,
        slug: fixture.slug,
        expected: admission.expected,
        actual,
        classification: outcome,
        wait: progress.wait,
        artifact,
      };

      progress = { ...progress, result };
      atomic(path, progress);

      return result;
    }

    await Bun.sleep(1000);
  }

  throw new Error(
    `Run ${runId} exceeded driver observation deadline. Its durable run remains available.`,
  );
}
