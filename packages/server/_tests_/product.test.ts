import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import type { LocalApiRunSnapshot } from "@loopy/local-api";
import { startServer } from "../src/index";

test("saved graph binds inputs, routes, approves an exact attempt, retries, verifies, replays and forks", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-product-"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  const server = await startServer({ projectDir: project, studioDir: project });
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value as T;
  };
  try {
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    const [pipeline, route, approval, retry, verify, skipped] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const edge = (source: string, target: string, label?: string) => ({
      id: crypto.randomUUID(),
      source,
      target,
      ...(label ? { label } : {}),
      metadata: {},
    });
    const definition = WorkflowDefinitionSchema.parse({
      ...fixture,
      name: "Product end-to-end",
      inputs: [{ name: "text", type: "string", required: true }],
      nodes: [
        {
          id: pipeline,
          kind: "shell",
          name: "Uppercase",
          execution: "host",
          stages: ["cat", "tr a-z A-Z"],
          inputBindings: { stdin: { kind: "workflow_input", name: "text" } },
        },
        {
          id: route,
          kind: "route",
          name: "Check text",
          predicate: {
            kind: "comparison",
            operator: "equals",
            left: {
              kind: "reference",
              reference: { kind: "node_output", nodeId: pipeline, path: ["stdout"] },
            },
            right: { kind: "literal", value: "HELLO" },
          },
        },
        {
          id: approval,
          kind: "approval",
          name: "Confirm",
          message: "Continue with the approved text?",
          approvalKey: "text",
        },
        {
          id: retry,
          kind: "shell",
          name: "Retry once",
          execution: "host",
          stages: [
            "if ! test -f attempted; then touch attempted; exit 9; fi; printf verified > result.txt; cat result.txt",
          ],
          retry: { maxAttempts: 2, backoffMs: 1, retryOn: [] },
        },
        {
          id: verify,
          kind: "verify",
          name: "Verify output",
          commands: [{ command: "bash", args: ["-c", "test $(cat result.txt) = verified"] }],
        },
        {
          id: skipped,
          kind: "shell",
          name: "Wrong branch",
          execution: "host",
          stages: ["exit 23"],
        },
      ],
      edges: [
        edge(pipeline, route),
        edge(route, approval, "true"),
        edge(route, skipped, "false"),
        edge(approval, retry),
        edge(retry, verify),
      ],
    });
    definition.policies.workspace = {
      useGitWorktree: false,
      allowDirtyWorkspace: true,
      writableRoots: [project],
    };
    await api("/workflows", { definition });
    const started = await api<{ id: string }>("/runs", {
      workflowId: definition.id,
      input: { text: "hello" },
    });
    let pending: LocalApiRunSnapshot | undefined;
    for (let i = 0; i < 200; i++) {
      pending = await api(`/runs/${started.id}`);
      if (pending?.attempts.some((a) => a.status === "blocked_approval")) break;
      await Bun.sleep(10);
    }
    const gate = pending?.attempts.find((a) => a.nodeId === approval);
    expect(gate?.status).toBe("blocked_approval");
    await expect(
      api(`/runs/${started.id}/approve`, {
        nodeId: approval,
        attemptId: "stale",
        decision: "approved",
      }),
    ).rejects.toThrow("approval_conflict");
    await api(`/runs/${started.id}/approve`, {
      nodeId: approval,
      attemptId: gate?.attemptId,
      decision: "approved",
    });
    const finished = await server.runtime.wait(started.id);
    expect(finished.run.status).toBe("succeeded");
    expect(
      finished.attempts.filter((a) => a.nodeId === retry).map((a) => a.output?.exitCode),
    ).toEqual([9, 0]);
    expect(finished.attempts.find((a) => a.nodeId === skipped)?.status).toBe("skipped");
    expect(finished.attempts.find((a) => a.nodeId === verify)?.status).toBe("succeeded");
    const replay = await api<{ frames: unknown[] }>(`/runs/${started.id}/replay`, {});
    expect(replay.frames).toHaveLength(finished.events.length);
    const snapshot = await api<LocalApiRunSnapshot>(`/runs/${started.id}`);
    const checkpoint = snapshot.events.find(
      (e) => e.type === "node.completed" && e.nodeId === verify,
    );
    expect(checkpoint).toBeDefined();
    const fork = await api<{ id: string }>(`/runs/${started.id}/fork`, {
      checkpointEventId: checkpoint?.id,
    });
    expect((await server.runtime.wait(fork.id)).run.status).toBe("succeeded");
    expect((await server.runtime.snapshot(started.id)).attempts).toHaveLength(
      finished.attempts.length,
    );
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
}, 15_000);
