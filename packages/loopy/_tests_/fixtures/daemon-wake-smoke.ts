import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type Json, runSnapshotViewSchema, runViewSchema } from "@loopy/contract";
import { readDaemonFile } from "@loopy/runtime/local";
import { Schema } from "effect";
import { CLI, fixture, save } from "../cli-fixture";

const repo = resolve(import.meta.dir, "../../../..");

const evidenceDirectory = resolve(repo, process.argv[2] ?? ".loopy/evidence/daemon-wake-smoke");

const branchResult = Bun.spawnSync(["git", "branch", "--show-current"], {
  cwd: repo,
  env: { PATH: process.env.PATH },
  stdout: "pipe",
  stderr: "pipe",
});

if (branchResult.exitCode !== 0) {
  throw new Error("Cannot identify the checkout branch for smoke evidence.");
}

const branch = branchResult.stdout.toString().trim();

const evidence = join(evidenceDirectory, "daemon-wake-smoke.json");

mkdirSync(evidenceDirectory, { recursive: true });

const f = fixture("daemon-wake-smoke", 'run: () => sh(["printf", "daemon-wake-smoke"])');

const protectedPorts = new Set([
  4310, 4173, 14870, 14871, 14872, 14873, 15070, 15071, 15072, 15073,
]);

const processHome = join(f.cwd, "process-home");

mkdirSync(processHome);

async function source() {
  const files = await Array.fromAsync(
    new Bun.Glob("*/src/**/*.ts").scan({ cwd: join(repo, "packages"), absolute: true }),
  );

  const digest = createHash("sha256");

  for (const file of files.sort()) {
    digest.update(`${relative(join(repo, "packages"), file)}\0`);
    digest.update(
      await Bun.file(file)
        .arrayBuffer()
        .then((bytes) => Buffer.from(bytes)),
    );
  }

  return {
    files: files.length,
    sha256: digest.digest("hex"),
    daemonSha256: createHash("sha256")
      .update(await Bun.file(join(repo, "packages/runtime/src/host/daemon.ts")).text())
      .digest("hex"),
  };
}

await save(f);

const before = await source();

const spawnedAt = new Date().toISOString();

const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    CLI,
    "--home",
    f.home,
    "--cwd",
    f.cwd,
    "daemon",
    "run",
    "--port",
    "0",
    "--concurrency",
    "1",
  ],
  {
    cwd: f.cwd,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: processHome, LOOPY_HOME: f.home },
    stdout: Bun.file(join(evidenceDirectory, "daemon-wake-smoke.stdout.log")),
    stderr: Bun.file(join(evidenceDirectory, "daemon-wake-smoke.stderr.log")),
  },
);

const measurements = [];

let exitCode: number | null = null;

try {
  const readyDeadline = Date.now() + 10_000;

  while (!readDaemonFile(f.home)) {
    if (child.exitCode !== null || Date.now() >= readyDeadline) {
      throw new Error("Owned daemon did not publish discovery within ten seconds.");
    }

    await Bun.sleep(20);
  }

  const record = readDaemonFile(f.home);

  if (!record || record.pid !== child.pid || protectedPorts.has(record.port)) {
    throw new Error("Daemon discovery must match this child on an unprotected ephemeral port.");
  }

  const readyAt = new Date().toISOString();
  const headers = { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" };
  const origin = `http://127.0.0.1:${record.port}`;

  async function request(path: string, body?: Json) {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Isolated HTTP request failed with ${response.status}.`);
    }

    const value: unknown = await response.json();

    return value;
  }

  for (let index = 0; index < 3; index++) {
    // Admission lands inside the daemon's idle wait rather than its startup scan.
    await Bun.sleep(200);
    const admittedAt = new Date().toISOString();
    const admissionStart = performance.now();

    const run = Schema.decodeUnknownSync(runViewSchema, { onExcessProperty: "error" })(
      await request("/loopies/daemon-wake-smoke/runs", {
        workspace: f.cwd,
        input: {},
      }),
    );

    const admissionMs = performance.now() - admissionStart;
    const deadline = Date.now() + 8000;

    let snapshot = Schema.decodeUnknownSync(runSnapshotViewSchema, { onExcessProperty: "error" })(
      await request(`/runs/${run.id}`),
    );

    while (snapshot.run.status !== "succeeded") {
      if (snapshot.run.status === "failed" || Date.now() >= deadline) {
        throw new Error(
          `Isolated run did not succeed within eight seconds: ${snapshot.run.status}`,
        );
      }

      await Bun.sleep(10);
      snapshot = Schema.decodeUnknownSync(runSnapshotViewSchema, { onExcessProperty: "error" })(
        await request(`/runs/${run.id}`),
      );
    }

    const firstNodeAt = snapshot.nodeRuns.map((node) => node.startedAt).sort()[0];

    if (!firstNodeAt) {
      throw new Error("Successful shell run has no persisted node timestamp.");
    }

    measurements.push({
      index,
      runId: run.id,
      admittedAt,
      createdAt: run.createdAt,
      admissionMs,
      firstNodeAt,
      createdToNodeMs: Date.parse(firstNodeAt) - Date.parse(run.createdAt),
      admissionToNodeMs: Date.parse(firstNodeAt) - Date.parse(admittedAt),
      daemonStartupToNodeMs: Date.parse(firstNodeAt) - Date.parse(record.startedAt),
      spawnToNodeMs: Date.parse(firstNodeAt) - Date.parse(spawnedAt),
      status: snapshot.run.status,
      output: snapshot.run.output,
    });
  }

  const after = await source();

  if (before.sha256 !== after.sha256 || before.daemonSha256 !== after.daemonSha256) {
    throw new Error("Source changed during the isolated measurement.");
  }

  child.kill("SIGTERM");
  exitCode = await Promise.race([
    child.exited,
    Bun.sleep(3000).then(() => {
      throw new Error("Owned daemon did not stop within three seconds.");
    }),
  ]);
  const discoveryRemoved = !existsSync(join(f.home, "daemon.json"));

  if (exitCode !== 0 || !discoveryRemoved) {
    throw new Error("Owned daemon did not stop cleanly and remove discovery.");
  }

  rmSync(f.cwd, { recursive: true, force: true });

  await Bun.write(
    evidence,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        bun: Bun.version,
        branch,
        cwd: repo,
        isolatedHome: f.home,
        isolatedWorkspace: f.cwd,
        pid: child.pid,
        port: record.port,
        spawnedAt,
        readyAt,
        daemonStartedAt: record.startedAt,
        before,
        after,
        measurements,
        exitCode,
        discoveryRemoved,
        isolatedStateRemoved: !existsSync(f.cwd),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");

    const stopped = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);

    if (!stopped) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  rmSync(f.cwd, { recursive: true, force: true });
}

console.log(JSON.stringify({ evidence, runs: measurements.length, exitCode }));
