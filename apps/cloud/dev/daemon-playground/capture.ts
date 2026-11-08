import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { decodeBoundary, type RunSnapshotView, routes } from "@loopy/contract";
import { errnoCode, executionKeyString } from "@loopy/core";
import { Schema, Struct } from "effect";
import {
  receiptSchema,
  runReceiptDirectory,
} from "../../../../packages/runtime/src/executor/receipts";
import { lstatOrAbsent } from "../shared/fs";
import { sha256Hex } from "../shared/hash";
import { home, state } from "./config";
import type { OwnedDaemon } from "./daemon";
import { sortedFiles } from "./prepare";

// Fixtures write this identity into results/result.json; extra result fields are workflow-specific.
export const artifactIdentitySchema = Schema.Struct({
  batch: Schema.String,
  ordinal: Schema.Number,
  slug: Schema.String,
});

const decodeArtifactIdentity = Schema.decodeUnknownSync(artifactIdentitySchema);

async function artifactIdentity(snapshot: RunSnapshotView, workspace: string) {
  const file = join(workspace, "loopies-playground/results/result.json");

  if (!(await lstatOrAbsent(file))) {
    if (snapshot.run.status === "succeeded") {
      throw new Error(`Successful run ${snapshot.run.id} did not write its catalog artifact.`);
    }

    return null;
  }

  const actual = decodeArtifactIdentity(JSON.parse(await readFile(file, "utf8")));

  const input = Schema.decodeUnknownSync(
    artifactIdentitySchema.mapFields(Struct.pick(["batch", "ordinal"])),
  )(snapshot.run.input);

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
  const directory = runReceiptDirectory(home, runId);

  const files = await lstat(directory).then(
    () => sortedFiles(directory),
    (cause: unknown) => {
      if (errnoCode(cause) !== "ENOENT") {
        throw cause;
      }

      return [];
    },
  );

  return Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file);
      const receipt = decodeBoundary(receiptSchema)(JSON.parse(bytes.toString("utf8")));

      return {
        path: relative(home, file),
        sha256: sha256Hex(bytes),
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

  if (await lstatOrAbsent(directory)) {
    await cp(directory, join(destination, "loopies-playground"), { recursive: true });

    for (const file of await sortedFiles(directory)) {
      const bytes = await readFile(file);
      outputs.push({
        path: relative(workspace, file),
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      });
    }
  }

  const retried = [];

  for (const node of snapshot.nodeRuns.filter((item) => item.attempt > 1)) {
    const detail = await daemon.call(routes.execution, {
      params: { id: runId },
      query: { key: executionKeyString(node.key) },
    });

    retried.push({ key: node.key, attempts: detail.attempts });
  }

  return {
    run: snapshot.run,
    nodeRuns: snapshot.nodeRuns,
    retried,
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
      nodeRunsNext: snapshot.nodeRunsNext,
      hooks: snapshot.hooksTruncated,
    },
  };
}
