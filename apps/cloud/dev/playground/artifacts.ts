import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeBoundary, type RunSnapshotView } from "@loopy/contract";
import { cloudRoutes } from "@loopy/contract/sandbox";
import { publishExclusive } from "@loopy/runtime/os";
import { Schema } from "effect";
import { sha256Hex } from "../shared/hash";
import type { PlaygroundClient } from "./client";
import { profile } from "./config";
import type { CatalogEntry } from "./repository";

// Fixture artifacts carry their own payload; only the identity fields are checked here.
const decodeEnvelope = (bytes: Uint8Array) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ batch: Schema.String, ordinal: Schema.Int, slug: Schema.String }),
  )(JSON.parse(Buffer.from(bytes).toString("utf8")));

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

  const artifact = await client.call(cloudRoutes.artifact, {
    query: encodeBoundary(cloudRoutes.artifact.query)({
      executionKey: node.key,
      attempt: node.attempt,
      path: fixture.artifactPath,
    }),
  });

  const bytes = Buffer.from(artifact.bytes, "base64");
  const hash = sha256Hex(bytes);

  if (
    artifact.size !== bytes.length ||
    hash !== artifact.sha256 ||
    artifact.path !== fixture.artifactPath
  ) {
    throw new Error("Artifact path, size or SHA-256 does not match the authenticated export.");
  }

  const envelope = decodeEnvelope(bytes);

  if (
    envelope.batch !== input.batch ||
    envelope.ordinal !== input.ordinal ||
    envelope.slug !== fixture.slug
  ) {
    throw new Error("Exported artifact does not match the expected batch, ordinal and workflow.");
  }

  const directory = resolve(profile.repository, "results", input.batch, fixture.slug);
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${snapshot.run.id}.json`);

  if (!publishExclusive(destination, bytes, 0o600)) {
    const existing = await readFile(destination);

    if (!existing.equals(bytes)) {
      throw new Error(
        "Existing materialized artifact differs from the authenticated export. Refusing to overwrite it.",
      );
    }

    decodeEnvelope(existing);
  }

  return { expectedPath: fixture.artifactPath, destination, sha256: hash, bytes: bytes.length };
}

export async function verifySaved(
  record: { destination: string; sha256: string; bytes: number },
  input: { batch: string; ordinal: number },
  slug: string,
) {
  const bytes = await readFile(record.destination);
  const envelope = decodeEnvelope(bytes);

  if (
    bytes.length !== record.bytes ||
    sha256Hex(bytes) !== record.sha256 ||
    envelope.batch !== input.batch ||
    envelope.ordinal !== input.ordinal ||
    envelope.slug !== slug
  ) {
    throw new Error("Saved artifact no longer matches its durable completion record.");
  }
}
