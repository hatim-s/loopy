import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import type { ProviderResult } from "@loopy/runtime";
import { startServer } from "../src/index";

for (const action of ["pause", "shutdown"] as const) {
  test(`retains an automatic retry across ${action} and resumes exactly once`, async () => {
    const project = mkdtempSync(resolve(tmpdir(), "loopy-pause-retry-"));
    writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
    let finish: ((result: ProviderResult) => void) | undefined;
    let calls = 0;
    const provider = {
      async execute(): Promise<ProviderResult> {
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return { status: "succeeded" };
      },
    };
    let server = await startServer({ projectDir: project, studioDir: project, provider });
    try {
      const workflow = WorkflowDefinitionSchema.parse(
        await Bun.file(
          new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
        ).json(),
      );
      workflow.nodes = workflow.nodes.filter((node) => node.kind === "agent");
      workflow.inputs = [];
      workflow.edges = [];
      workflow.defaults.retry = { maxAttempts: 2, backoffMs: 0, retryOn: [] };
      const run = await server.runtime.start(workflow);
      for (let i = 0; i < 200 && !finish; i++) await Bun.sleep(5);
      expect(finish).toBeDefined();
      const stopping = action === "shutdown" ? server.stop() : server.runtime.pause(run.runId);
      for (let i = 0; i < 200; i++) {
        if ((await server.runtime.snapshot(run.runId)).run.status === "pause_requested") break;
        await Bun.sleep(5);
      }
      finish?.({ status: "failed", error: "transient" });
      await stopping;
      if (action === "shutdown")
        server = await startServer({ projectDir: project, studioDir: project, provider });
      for (let i = 0; i < 200; i++) {
        if ((await server.runtime.snapshot(run.runId)).run.status === "paused") break;
        await Bun.sleep(5);
      }
      const paused = await server.runtime.snapshot(run.runId);
      expect(paused.run.status).toBe("paused");
      expect(paused.attempts.map((attempt) => attempt.status)).toEqual(["failed", "pending"]);
      expect(calls).toBe(1);
      await server.runtime.resume(run.runId);
      expect((await server.runtime.wait(run.runId)).run.status).toBe("succeeded");
      expect(calls).toBe(2);
    } finally {
      await server.stop();
      rmSync(project, { recursive: true, force: true });
    }
  });
}
