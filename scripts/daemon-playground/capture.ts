import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { type RunSnapshotView, routes } from "../../packages/loopy/src/contract/index.ts";
import { executionKeyString } from "../../packages/loopy/src/core/index.ts";
import { receiptSchema } from "../../packages/loopy/src/executor/receipts.ts";
import { home, state } from "./config.ts";
import type { OwnedDaemon } from "./daemon.ts";
import { treeFiles } from "./prepare.ts";

const artifactIdentitySchema = z.object({
  batch: z.string(),
  ordinal: z.number(),
  slug: z.string(),
});

async function artifactIdentity(snapshot: RunSnapshotView, workspace: string) {
  const file = join(workspace, "loopies-playground/results/result.json");

  if (!(await lstat(file).catch(() => null))) {
    if (snapshot.run.status === "succeeded") {
      throw new Error(`Successful run ${snapshot.run.id} did not write its catalog artifact.`);
    }

    return null;
  }

  const actual = artifactIdentitySchema.parse(JSON.parse(await readFile(file, "utf8")));
  const input = artifactIdentitySchema.omit({ slug: true }).parse(snapshot.run.input);

  const matched =
    actual.batch === input.batch &&
    actual.ordinal === input.ordinal &&
    actual.slug === snapshot.run.slug;

  if (!matched) {
    throw new Error(`Artifact identity does not match run ${snapshot.run.id}.`);
  }

  return { ...actual, matched };
}

export async function receiptInventory(runId: string) {
  const directory = join(home, "receipts", runId);

  const files = await lstat(directory)
    .then(() => treeFiles(directory))
    .catch(() => []);

  return Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file);
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")));

      return {
        path: relative(home, file),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        kind: receipt.kind,
        key: receipt.executionKey,
        attempt: receipt.attempt,
      };
    }),
  );
}

export async function capture(daemon: OwnedDaemon, snapshot: RunSnapshotView, workspace: string) {
  const runId = snapshot.run.id;
  const directory = join(workspace, "loopies-playground");
  const destination = join(state, "artifacts", runId);
  await mkdir(destination, { recursive: true });
  const outputs = [];

  if (await lstat(directory).catch(() => null)) {
    await cp(directory, join(destination, "loopies-playground"), { recursive: true });

    for (const file of await treeFiles(directory)) {
      const bytes = await readFile(file);
      outputs.push({
        path: relative(workspace, file),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  const retried = [];

  for (const node of snapshot.nodeRuns.filter((item) => item.attempt > 1)) {
    const query = new URLSearchParams({ key: executionKeyString(node.key) });

    const detail = await daemon.request(
      `/runs/${runId}/execution?${query}`,
      routes.execution.response,
    );

    retried.push({ key: node.key, attempts: detail.attempts });
  }

  const { waitingOn, ...run } = snapshot.run;

  return {
    run,
    waitingOn: waitingOn ? { ...waitingOn, token: "[omitted]" } : null,
    nodeRuns: snapshot.nodeRuns,
    retried,
    logs: snapshot.logs,
    hooks: snapshot.hooks.map((hook) => ({
      runId: hook.runId,
      seq: hook.seq,
      name: hook.name,
      createdAt: hook.createdAt,
      resolvedAt: hook.resolvedAt,
      expiredAt: hook.expiredAt,
      payload: hook.payload,
    })),
    outputs,
    artifactIdentity: await artifactIdentity(snapshot, workspace),
    outputDirectory: destination,
    receipts: await receiptInventory(runId),
    latestNodeCount: snapshot.nodeRuns.length,
    firstNodeStartedAt: snapshot.nodeRuns.map((node) => node.startedAt).sort()[0] ?? null,
    attemptCount: snapshot.nodeRuns.reduce((count, node) => count + node.attempt, 0),
    truncation: {
      nodeRunsNext: snapshot.nodeRunsNext ?? null,
      hooks: snapshot.hooksTruncated ?? false,
    },
  };
}
