import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderRegistry, type ProviderAdapter, type ProviderRun } from "@loopy/providers";
import type { RuntimeScheduler } from "@loopy/runtime";
import { SqliteRuntimeStore, Storage } from "@loopy/storage";
import { describe, expect, it, vi } from "vitest";
import { main, mainAsync } from "../src/index";

describe("loopy CLI shell", () => {
  it("initializes idempotently without overwriting project-local config", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-init-"));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await mainAsync(["init", "--project", project, "--json"])).toBe(0);
      const configPath = resolve(project, ".loopy/config.json");
      expect(existsSync(configPath)).toBe(true);
      const initial = await Bun.file(configPath).text();
      await Bun.write(configPath, '{"userSetting":true}\n');
      expect(await mainAsync(["init", "--project", project, "--json"])).toBe(0);
      expect(await Bun.file(configPath).text()).toBe('{"userSetting":true}\n');
      expect(initial).not.toBe(await Bun.file(configPath).text());
    } finally {
      output.mockRestore();
    }
  });

  it("imports and deterministically exports a canonical trace through SQLite", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-trace-"));
    const outputFile = resolve(project, "roundtrip.jsonl");
    const fixture = resolve("packages/tracing/fixtures/trace.jsonl");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await mainAsync(["trace", "import", fixture, "--project", project])).toBe(0);
      expect(
        await mainAsync([
          "trace",
          "export",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "--output",
          outputFile,
          "--project",
          project,
        ]),
      ).toBe(0);
      expect(await Bun.file(outputFile).text()).toBe(await Bun.file(fixture).text());
    } finally {
      output.mockRestore();
    }
  });

  it("routes lifecycle commands with their required run and node inputs", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-controls-"));
    const calls: unknown[][] = [];
    const fake = {
      pause: async (runId: string) => {
        calls.push(["pause", runId]);
        return { runId, status: "paused" };
      },
      resume: async (runId: string) => {
        calls.push(["resume", runId]);
        return { runId, status: "running" };
      },
      cancel: async (runId: string, reason: string) => {
        calls.push(["cancel", runId, reason]);
        return { runId, status: "cancelled" };
      },
      retry: async (runId: string, nodeId: string, input: Record<string, unknown>) => {
        calls.push(["retry", runId, nodeId, input]);
        return { runId, nodeId, status: "pending" };
      },
    } as unknown as RuntimeScheduler;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const dependencies = { runtimeFactory: () => fake };
      expect(await mainAsync(["pause", "run-1", "--project", project], dependencies)).toBe(0);
      expect(await mainAsync(["resume", "run-1", "--project", project], dependencies)).toBe(0);
      expect(
        await mainAsync(
          ["cancel", "run-1", "--reason", "operator request", "--project", project],
          dependencies,
        ),
      ).toBe(0);
      expect(
        await mainAsync(
          ["retry", "run-1", "--node", "node-1", "--input", '{"x":1}', "--project", project],
          dependencies,
        ),
      ).toBe(0);
      expect(calls).toEqual([
        ["pause", "run-1"],
        ["resume", "run-1"],
        ["cancel", "run-1", "operator request"],
        ["retry", "run-1", "node-1", { x: 1 }],
      ]);
    } finally {
      output.mockRestore();
    }
  });

  it("leaves fork inputs undefined when --input is omitted", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-fork-input-"));
    const calls: unknown[][] = [];
    const fake = {
      fork: async (runId: string, nodeId: string, input?: Record<string, unknown>) => {
        calls.push([runId, nodeId, input]);
        return { runId: "forked", status: "succeeded" };
      },
      wait: async () => ({ run: { runId: "forked", status: "succeeded" } }),
    } as unknown as RuntimeScheduler;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(
        await mainAsync(["fork", "run-1", "--from-node", "checkpoint", "--project", project], {
          runtimeFactory: () => fake,
        }),
      ).toBe(0);
      expect(calls).toEqual([["run-1", "checkpoint", undefined]]);
    } finally {
      output.mockRestore();
    }
  });

  const fakeLiveAdapter = (available = true): ProviderAdapter => ({
    id: "codex",
    version: "test-1",
    probe: async () => ({
      provider: "codex",
      available,
      capabilities: {
        schemaVersion: "1",
        capabilities: { structuredStreamingEvents: { status: "supported" } },
        supported: ["structuredStreamingEvents"],
        degraded: [],
        unavailable: [],
      },
      ...(available ? {} : { diagnostic: "test provider unavailable" }),
    }),
    capabilities: () => ({
      schemaVersion: "1",
      capabilities: { structuredStreamingEvents: { status: "supported" } },
      supported: ["structuredStreamingEvents"],
      degraded: [],
      unavailable: [],
    }),
    start: async (request) =>
      ({
        session: Promise.resolve({ provider: "codex", sessionId: `${request.attemptId}-session` }),
        events: (async function* () {
          yield {
            type: "session_started" as const,
            provider: "codex",
            occurredAt: "2026-08-17T00:00:00.000Z",
            provenance: { sessionId: `${request.attemptId}-session` },
            payload: {},
          };
          yield {
            type: "message" as const,
            provider: "codex",
            occurredAt: "2026-08-17T00:00:01.000Z",
            provenance: { sessionId: `${request.attemptId}-session` },
            payload: { role: "assistant", content: "live result" },
          };
          yield {
            type: "session_ended" as const,
            provider: "codex",
            occurredAt: "2026-08-17T00:00:02.000Z",
            provenance: { sessionId: `${request.attemptId}-session` },
            payload: { status: "succeeded" },
          };
        })(),
        cancel: async () => undefined,
      }) as ProviderRun,
    historicalImports: [],
  });

  it("lists registered provider availability and capabilities without starting an agent", async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    const start = vi.fn();
    const adapter = { ...fakeLiveAdapter(), start };
    try {
      expect(
        await mainAsync(["providers", "--json"], {
          registry: createProviderRegistry([adapter]),
        }),
      ).toBe(0);
      const result = JSON.parse(output[0] ?? "{}");
      expect(result.providers[0]).toMatchObject({
        provider: "codex",
        available: true,
        capabilities: { supported: ["structuredStreamingEvents"] },
      });
      expect(start).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("runs --live only through the selected available adapter and persists provider trace", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-live-"));
    const traceOutput = resolve(project, "live-trace.jsonl");
    const setup = new Storage({ projectDir: project });
    setup.runtime.createWorkflowVersion({
      workflowId: "live-workflow",
      version: 1,
      definition: {
        id: "live-workflow",
        workflowVersion: 1,
        nodes: [{ id: "agent", kind: "agent", provider: "codex", prompt: "hello" }],
        edges: [],
      },
    });
    setup.close();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.map(String).join(" "));
    });
    try {
      expect(
        await mainAsync(
          ["run", "live-workflow", "--provider", "codex", "--live", "--project", project, "--json"],
          {
            registry: createProviderRegistry([fakeLiveAdapter()]),
          },
        ),
      ).toBe(0);
      const run = JSON.parse(output.at(-1) ?? "{}");
      expect(run.run.status).toBe("succeeded");
      const persistedWorkflow = new Storage({ projectDir: project });
      const persistedRun = new SqliteRuntimeStore(persistedWorkflow).getRun(run.run.runId);
      expect((await persistedRun)?.plan.execution).toEqual({ mode: "live", provider: "codex" });
      expect((await persistedRun)?.plan.nodes[0]?.provider).toBe("codex");
      persistedWorkflow.close();
      const persisted = new Storage({ projectDir: project });
      const persistedRuntime = new SqliteRuntimeStore(persisted);
      const runtimeId = run.run.runId as string;
      expect(runtimeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const traceRows = persisted.db
        .query<{ run_id: string; trace_json: string | null }, [string]>(
          "SELECT run_id,trace_json FROM events WHERE run_id=? ORDER BY sequence",
        )
        .all(runtimeId);
      expect(traceRows.length).toBeGreaterThan(0);
      expect(traceRows.every((row) => row.run_id === runtimeId)).toBe(true);
      expect(traceRows.every((row) => JSON.parse(row.trace_json ?? "{}").runId === runtimeId)).toBe(
        true,
      );
      expect(
        traceRows.some((row) => JSON.parse(row.trace_json ?? "{}").type === "provider.message"),
      ).toBe(true);
      const persistedEvents = persistedRuntime.listTraceEvents(runtimeId);
      expect(persistedEvents.every((event) => event.runId === runtimeId)).toBe(true);
      persisted.close();

      expect(
        await mainAsync([
          "trace",
          "export",
          runtimeId,
          "--output",
          traceOutput,
          "--project",
          project,
        ]),
      ).toBe(0);
      const exportedEvents = (await Bun.file(traceOutput).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { runId: string; type: string });
      expect(exportedEvents.every((event) => event.runId === runtimeId)).toBe(true);
      expect(exportedEvents.some((event) => event.type === "provider.message")).toBe(true);

      expect(await mainAsync(["replay", runtimeId, "--project", project, "--json"])).toBe(0);
      const replay = JSON.parse(output.at(-1) ?? "{}") as {
        run: { runId: string };
        frames: Array<{ event: { runId: string } }>;
      };
      expect(replay.run.runId).toBe(runtimeId);
      expect(replay.frames.length).toBeGreaterThan(0);
      expect(replay.frames.every((frame) => frame.event.runId === runtimeId)).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
  it("prints a version without invoking an unimplemented command", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(main(["--version"])).toBe(0);
    expect(output).toHaveBeenCalledWith("0.1.0");

    output.mockRestore();
  });

  it("routes replay and fork through the exported synchronous shell API", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-router-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["replay", "missing-run", "--project", project])).toBe(0);
      expect(main(["fork", "missing-run", "--from-node", "node", "--project", project])).toBe(0);
      await Bun.sleep(10);
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("not implemented"));
    } finally {
      process.exitCode = 0;
      error.mockRestore();
    }
  });

  it("returns a non-zero status when run is missing its approved workflow", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await mainAsync(["run"])).toBe(1);
    expect(error).toHaveBeenCalledWith("loopy: run requires a workflow ID");

    error.mockRestore();
  });

  it("executes the package bin entry point directly", async () => {
    const packageDirectory = resolve(fileURLToPath(import.meta.url), "../..");
    const packageJson = (await Bun.file(resolve(packageDirectory, "package.json")).json()) as {
      bin: { loopy: string };
    };
    if (!existsSync(resolve(packageDirectory, packageJson.bin.loopy)))
      Bun.spawnSync([process.execPath, "run", "build"], {
        cwd: packageDirectory,
        stdout: "ignore",
        stderr: "ignore",
      });
    const result = Bun.spawnSync([resolve(packageDirectory, packageJson.bin.loopy), "--version"]);

    expect(result.success).toBe(true);
    expect(result.stdout?.toString().trim()).toBe("0.1.0");
  });

  it("runs an approved extracted workflow through the local fake runtime", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-flow-"));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map((value) => String(value)).join(" "));
    });
    const lastJson = <T>(): T => JSON.parse(output.at(-1) ?? "null") as T;
    try {
      const fixture = resolve("fixtures/sessions/successful.json");
      expect(
        await mainAsync(["import", fixture, "--provider", "codex", "--project", project, "--json"]),
      ).toBe(0);
      const imported = lastJson<{ id: string }>();

      expect(
        await mainAsync(["extract", "--import", imported.id, "--project", project, "--json"]),
      ).toBe(0);
      const extraction = lastJson<{ output: { proposal: { id: string } } }>();

      expect(
        await mainAsync([
          "review",
          "show",
          extraction.output.proposal.id,
          "--project",
          project,
          "--json",
        ]),
      ).toBe(0);
      const review = lastJson<{ proposal: { id: string; workflow: { id: string } } }>();
      expect(await mainAsync(["approve", review.proposal.id, "--project", project, "--json"])).toBe(
        0,
      );

      expect(
        await mainAsync([
          "run",
          review.proposal.workflow.id,
          "--project",
          project,
          "--local",
          "--input",
          JSON.stringify({ task: "replay" }),
          "--json",
        ]),
      ).toBe(0);
      const run = lastJson<{ run: { status: string }; attempts: unknown[] }>();
      expect(run.run.status).toBe("succeeded");
      expect(run.attempts.length).toBeGreaterThan(0);

      const persisted = new Storage({ projectDir: project });
      expect(persisted.runtime.listWorkflowVersions()).toHaveLength(1);
      expect(persisted.runtime.listRuns("succeeded")).toHaveLength(1);
      const runId = persisted.runtime.listRuns("succeeded")[0]?.id;
      persisted.close();
      expect(runId).toBeDefined();
      expect(await mainAsync(["replay", runId as string, "--project", project, "--json"])).toBe(0);
      expect(lastJson<{ frames: unknown[] }>().frames.length).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
    }
  });

  it("creates and inspects local schedules through JSON CLI commands", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-schedule-"));
    const setup = new Storage({ projectDir: project });
    const definition = (await Bun.file(resolve("fixtures/workflows/valid-basic.json")).json()) as {
      id: string;
    };
    definition.id = "workflow-1";
    setup.runtime.createWorkflowVersion({
      workflowId: "workflow-1",
      definition,
    });
    setup.close();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map((value) => String(value)).join(" "));
    });
    try {
      expect(
        await mainAsync([
          "schedule",
          "create",
          "--id",
          "hourly",
          "--workflow",
          "workflow-1",
          "--cron",
          "0 * * * *",
          "--timezone",
          "UTC",
          "--project",
          project,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(output.at(-1) ?? "null").id).toBe("hourly");
      expect(await mainAsync(["schedule", "list", "--project", project, "--json"])).toBe(0);
      expect(JSON.parse(output.at(-1) ?? "[]")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("fires a persisted schedule through the SQLite runtime and exposes its events", async () => {
    const project = mkdtempSync(join(tmpdir(), "loopy-cli-scheduled-run-"));
    const setup = new Storage({ projectDir: project });
    setup.runtime.createWorkflowVersion({
      workflowId: "scheduled-workflow",
      version: 1,
      definition: {
        id: "scheduled-workflow",
        workflowVersion: 1,
        nodes: [{ id: "agent", kind: "agent", name: "agent", prompt: "scheduled" }],
        edges: [],
        policies: { concurrency: { maxParallel: 1 } },
      },
    });
    setup.close();
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.map((value) => String(value)).join(" "));
    });
    try {
      expect(
        await mainAsync([
          "schedule",
          "create",
          "--id",
          "scheduled",
          "--workflow",
          "scheduled-workflow",
          "--cron",
          "* * * * *",
          "--timezone",
          "UTC",
          "--project",
          project,
          "--json",
        ]),
      ).toBe(0);
      expect(
        await mainAsync(["schedule", "fire", "scheduled", "--project", project, "--json"]),
      ).toBe(0);
      const fired = JSON.parse(output.at(-1) ?? "null") as {
        run: { run: { status: string }; events: unknown[] };
      };
      expect(fired.run.run.status).toBe("succeeded");
      expect(fired.run.events.length).toBeGreaterThan(0);
      const persisted = new Storage({ projectDir: project });
      expect(persisted.runtime.listRuns("succeeded")).toHaveLength(1);
      expect(
        persisted.runtime.countEvents(persisted.runtime.listRuns("succeeded")[0]?.id ?? ""),
      ).toBeGreaterThan(0);
      expect(persisted.schedules.listFires("scheduled")).toHaveLength(1);
      expect(persisted.schedules.listLinks("scheduled", "terminal")).toHaveLength(1);
      persisted.close();
    } finally {
      log.mockRestore();
    }
  });

  it("keeps UI tests listener-free and supports an injected launcher/server", async () => {
    const launched: string[] = [];
    let stopped = false;
    const code = await mainAsync(
      ["ui", "--no-open", "--project", mkdtempSync(join(tmpdir(), "loopy-ui-"))],
      {
        ui: {
          studioDir: tmpdir(),
          serverFactory: ({ config }) => ({
            url: `http://${config.host}:${config.port}/`,
            token: config.token,
            stop: () => {
              stopped = true;
            },
          }),
          launcher: (url) => {
            launched.push(url);
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(launched).toEqual([]);
    expect(stopped).toBe(false);
  });
});
