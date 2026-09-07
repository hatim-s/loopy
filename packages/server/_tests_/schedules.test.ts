import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { startServer } from "../src/index";

test("daemon schedules preserve local simulation and explicit live execution", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-schedule-mode-"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  let liveCalls = 0;
  const server = await startServer({
    projectDir: project,
    studioDir: project,
    provider: {
      async execute() {
        liveCalls++;
        return { status: "succeeded" };
      },
    },
  });
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  try {
    const workflow = WorkflowDefinitionSchema.parse(
      await Bun.file(
        new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
      ).json(),
    );
    workflow.nodes = workflow.nodes.filter((node) => node.kind === "agent");
    workflow.edges = [];
    for (const node of workflow.nodes) if (node.kind === "agent") node.inputBindings = {};
    workflow.inputs = [];
    workflow.policies.workspace = {
      useGitWorktree: false,
      allowDirtyWorkspace: true,
      writableRoots: [project],
    };
    await api("/workflows", { definition: workflow });
    for (const mode of ["local", "live"] as const) {
      const schedule = await api("/schedules", {
        name: mode,
        workflowId: workflow.id,
        workflowVersion: 1,
        expression: "manual",
        executionMode: mode,
      });
      expect(schedule.executionMode).toBe(mode);
      const fire = await api(`/schedules/${schedule.id}/fire`, { fireKey: crypto.randomUUID() });
      const snapshot = await server.runtime.wait(fire.fire.runId);
      expect(snapshot.run.status).toBe("succeeded");
      expect(snapshot.run.plan.execution?.mode).toBe(mode);
      expect(liveCalls).toBe(mode === "local" ? 0 : 1);
    }
    const local = await api("/schedules", {
      name: "local tick",
      workflowId: workflow.id,
      workflowVersion: 1,
      expression: "* * * * *",
      missedPolicy: "run_once",
    });
    await api("/schedules/tick", { now: local.nextFireAt });
    const details = await api(`/schedules/${local.id}`);
    expect(details.fires).toHaveLength(1);
    const snapshot = await server.runtime.wait(details.fires[0].runId);
    expect(snapshot.run.plan.execution?.mode).toBe("local");
    expect(liveCalls).toBe(1);
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
