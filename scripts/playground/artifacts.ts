import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { type RunSnapshotView, sandboxArtifactSchema } from "../../packages/loopy/src/contract";
import type { PlaygroundClient } from "./client";
import type { CatalogEntry } from "./repository";
import { repository } from "./repository";

const envelopeSchema = z
  .object({ batch: z.string(), ordinal: z.number().int(), slug: z.string() })
  .passthrough();

export async function materialize(
  client: PlaygroundClient,
  snapshot: RunSnapshotView,
  fixture: CatalogEntry,
  input: { batch: string; ordinal: number },
) {
  if (fixture.artifactPath === null || snapshot.run.status !== "succeeded") {
    return null;
  }

  const node = [...snapshot.nodeRuns]
    .reverse()
    .find((value) => value.status === "succeeded" && value.receipt === "finished");

  if (!node) {
    throw new Error(
      "Successful file writer has no finished execution to authorize artifact export.",
    );
  }

  const query = new URLSearchParams({
    key: JSON.stringify(node.key),
    attempt: String(node.attempt),
    path: fixture.artifactPath,
  });

  const artifact = await client.json(sandboxArtifactSchema, `/cloud/artifacts?${query}`);
  const bytes = Buffer.from(artifact.bytes, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");

  if (
    artifact.size !== bytes.length ||
    hash !== artifact.sha256 ||
    artifact.path !== fixture.artifactPath
  ) {
    throw new Error("Artifact path, size or SHA-256 does not match the authenticated export.");
  }

  const envelope = envelopeSchema.parse(JSON.parse(bytes.toString("utf8")));

  if (
    envelope.batch !== input.batch ||
    envelope.ordinal !== input.ordinal ||
    envelope.slug !== fixture.slug
  ) {
    throw new Error("Exported artifact does not match the expected batch, ordinal and workflow.");
  }

  const directory = resolve(repository, "results", input.batch, fixture.slug);
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${snapshot.run.id}.json`);

  try {
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
      throw cause;
    }

    const existing = await readFile(destination);

    if (!existing.equals(bytes)) {
      throw new Error(
        "Existing materialized artifact differs from the authenticated export. Refusing to overwrite it.",
      );
    }

    envelopeSchema.parse(JSON.parse(existing.toString("utf8")));
  }

  return { expectedPath: fixture.artifactPath, destination, sha256: hash, bytes: bytes.length };
}

export async function verifySaved(
  record: { destination: string; sha256: string; bytes: number },
  input: { batch: string; ordinal: number },
  slug: string,
) {
  const bytes = await readFile(record.destination);
  const envelope = envelopeSchema.parse(JSON.parse(bytes.toString("utf8")));

  if (
    bytes.length !== record.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== record.sha256 ||
    envelope.batch !== input.batch ||
    envelope.ordinal !== input.ordinal ||
    envelope.slug !== slug
  ) {
    throw new Error("Saved artifact no longer matches its durable completion record.");
  }
}
