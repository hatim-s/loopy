import { mkdir } from "node:fs/promises";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { PlaygroundClient } from "../client";
import { evidence } from "../config";
import { artifactPath, captureArtifact, decodePhaseName } from "./artifacts";
import { sampleApi } from "./sampler";

const decodeSeconds = decodeBoundary(
  Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 18, maximum: 3600 })),
);

const decodeRate = decodeBoundary(
  Schema.FiniteFromString.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
);

const phase = decodePhaseName(process.argv[2]);

const seconds = process.argv[3] === undefined ? 90 : decodeSeconds(process.argv[3]);

const requestsPerSecond = process.argv[4] === undefined ? 2 : decodeRate(process.argv[4]);

const artifact = captureArtifact(phase);

const client = await PlaygroundClient.open();

await mkdir(evidence, { recursive: true });

const output = artifactPath(evidence, artifact);

if (await Bun.file(output).exists()) {
  throw new Error("Evidence phase already exists. Choose a new phase to preserve measurements.");
}

let stopping = false;

process.once("SIGTERM", () => {
  stopping = true;
});

process.once("SIGINT", () => {
  stopping = true;
});

process.stdout.write(
  `${JSON.stringify({ phase, pid: process.pid, status: "sampling", output, stop: `kill -TERM ${process.pid}` })}\n`,
);

const result = await sampleApi(client, {
  phase,
  seconds,
  requestsPerSecond,
  shouldStop: () => stopping,
});

process.stdout.write(`${JSON.stringify({ ...result, output })}\n`);
