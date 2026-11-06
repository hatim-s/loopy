import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PlaygroundClient } from "../client";
import { atomic, evidenceDirectory } from "../config";
import { sampleApi } from "./sampler";

const args = z
  .tuple([
    z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    z.coerce.number().int().min(18).max(3600).default(90),
    z.coerce.number().min(1).max(3).default(2),
  ])
  .parse([process.argv[2], process.argv[3], process.argv[4]]);

const [phase, seconds, requestsPerSecond] = args;

const client = await PlaygroundClient.open();

const directory = evidenceDirectory;

await mkdir(directory, { recursive: true });

const output = resolve(directory, `playground-performance-${phase}.json`);

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

const result = await sampleApi({
  phase,
  seconds,
  requestsPerSecond,
  request: (path, signal) => client.request(path, signal),
  shouldStop: () => stopping,
  onProgress: (progress) =>
    process.stdout.write(`${JSON.stringify({ status: "progress", ...progress })}\n`),
  save: (value) =>
    atomic(output, {
      ...value,
      api: client.settings.api,
      dashboard: client.settings.dashboard,
      batch: client.settings.batch,
      workspace: client.settings.workspace,
      workloadControls: {
        apiSlots: client.settings.apiConcurrency,
        runtimeAttempts: client.settings.runtimeConcurrency,
      },
    }),
});

process.stdout.write(`${JSON.stringify({ ...result, output })}\n`);
