import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../src/core/model";
import { createLocalRuntime } from "../src/local/runtime";

test("migrates v1 run options without losing checkpoints or event history", async () => {
  const home = mkdtempSync(join(tmpdir(), "loopy-migration-"));
  const database = new Database(join(home, "runs.sqlite"), { create: true });
  const timestamp = "2026-01-01T00:00:00.000Z";
  const runId = "legacy-run";
  const workflow: Workflow = {
    version: 1,
    slug: "legacy",
    nodes: [
      {
        id: "effect",
        kind: "command",
        command: {
          program: "original-program",
          args: [{ $ref: { source: "input", path: ["name"] } }],
        },
      },
    ],
  };
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      workflow_json TEXT NOT NULL,
      workflow_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_token TEXT,
      owner_pid INTEGER,
      owner_host TEXT,
      heartbeat_at TEXT
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      number INTEGER NOT NULL CHECK(number > 0),
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(run_id, node_id, number)
    );
    CREATE TABLE events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      node_id TEXT,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    );
    PRAGMA user_version=1;
  `);
  database.run(
    "INSERT INTO runs(id,slug,workflow_json,workflow_hash,input_json,options_json,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      runId,
      workflow.slug,
      JSON.stringify(workflow),
      "legacy-hash",
      JSON.stringify({ name: "Ada" }),
      JSON.stringify({ cwd: home, mode: "full" }),
      "failed",
      "Command exited with code 7",
      timestamp,
      timestamp,
    ],
  );
  database.run(
    "INSERT INTO attempts(id,run_id,node_id,number,status,input_json,output_json,error,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      "legacy-attempt",
      runId,
      "effect",
      1,
      "failed",
      JSON.stringify({ program: "original-program", args: ["Ada"] }),
      JSON.stringify({ stdout: "try again", stderr: "", exitCode: 7, durationMs: 1 }),
      "Command exited with code 7",
      timestamp,
      timestamp,
    ],
  );
  database.run(
    "INSERT INTO events(run_id,sequence,node_id,type,data_json,created_at) VALUES (?,?,?,?,?,?)",
    [runId, 0, null, "run.created", JSON.stringify({ slug: workflow.slug }), timestamp],
  );
  database.run(
    "INSERT INTO events(run_id,sequence,node_id,type,data_json,created_at) VALUES (?,?,?,?,?,?)",
    [runId, 1, "effect", "node.failed", JSON.stringify({ attemptId: "legacy-attempt" }), timestamp],
  );
  database.close();

  const calls: string[] = [];
  const open = () =>
    createLocalRuntime({
      home,
      executor: async (command) => {
        calls.push(`${command.program} ${command.args.join(" ")}`);
        return { stdout: "done", stderr: "", exitCode: 0, durationMs: 1 };
      },
    });
  try {
    const first = open();
    try {
      expect(await first.runtime.getRun(runId)).toMatchObject({
        id: runId,
        workflowHash: "legacy-hash",
        workflow,
        input: { name: "Ada" },
        options: { workspace: { kind: "local", path: home }, mode: "full" },
        status: "failed",
      });
      expect(await first.runtime.getAttempts(runId)).toMatchObject([
        { id: "legacy-attempt", number: 1, status: "failed", output: { stdout: "try again" } },
      ]);
      expect((await first.runtime.getEvents(runId)).map((event) => event.sequence)).toEqual([0, 1]);
    } finally {
      first.close();
    }

    const second = open();
    try {
      expect((await second.runtime.getRun(runId))?.options).toEqual({
        workspace: { kind: "local", path: home },
        mode: "full",
      });
      expect((await second.runtime.execute(runId)).status).toBe("succeeded");
      expect(calls).toEqual(["original-program Ada"]);
      expect((await second.runtime.getAttempts(runId)).map((attempt) => attempt.status)).toEqual([
        "failed",
        "succeeded",
      ]);
      const events = await second.runtime.getEvents(runId);
      expect(events.slice(0, 2).map((event) => event.type)).toEqual(["run.created", "node.failed"]);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: events.length }, (_, index) => index),
      );
    } finally {
      second.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
