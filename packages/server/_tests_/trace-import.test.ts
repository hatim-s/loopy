import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startServer } from "../src/index";

test("trace-only imports remain inspectable across server shutdown and recovery", async () => {
  const project = mkdtempSync(resolve(tmpdir(), "loopy-trace-import-"));
  writeFileSync(resolve(project, "index.html"), "<html><head></head></html>");
  let server = await startServer({ projectDir: project, studioDir: project });
  const runId = crypto.randomUUID();
  try {
    const response = await fetch(`${server.url}/api/v1/traces/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${JSON.stringify({ schemaVersion: "1", id: crypto.randomUUID(), runId, sequence: 0, type: "run.created", occurredAt: new Date().toISOString(), monotonicOffsetMs: 0, payload: { workflowId: crypto.randomUUID(), workflowVersion: 1 }, redaction: { status: "none", removedFields: [] } })}\n`,
      }),
    });
    expect(response.status).toBe(201);
    await server.stop();
    server = await startServer({ projectDir: project, studioDir: project });
    const history = await fetch(`${server.url}/api/v1/runs/${runId}`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(history.status).toBe(200);
    const run = await history.json();
    expect(run.status).toBe("created");
    expect(run.events).toHaveLength(1);
  } finally {
    await server.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
