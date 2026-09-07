import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ShellNodeSchema, WorkflowDefinitionSchema } from "@loopy/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/index";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]?.text ?? "null");
}

test("an MCP client edits, detects stale versions, and runs the same saved graph as the UI", async () => {
  const path = mkdtempSync(resolve(tmpdir(), "loopy-mcp-"));
  writeFileSync(resolve(path, "index.html"), "<html><head></head><body>Loopy</body></html>");
  const server = await startServer({ projectDir: path, studioDir: path });
  const client = new Client({ name: "loopy-test", version: "1" });
  try {
    expect((await fetch(`${server.url}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
      }),
    );
    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toContain("apply_workflow_commands");
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const definition = WorkflowDefinitionSchema.parse(fixture);
    definition.nodes = [
      ShellNodeSchema.parse({
        id: crypto.randomUUID(),
        kind: "shell",
        name: "MCP pipeline",
        stages: ["sleep 0.2; printf hello", "tr a-z A-Z"],
        execution: "host",
        position: { x: 240, y: 120 },
      }),
    ];
    definition.edges = [];
    definition.inputs = [];
    definition.policies.workspace = {
      workingDirectory: path,
      useGitWorktree: false,
      allowDirtyWorkspace: true,
      writableRoots: [path],
    };
    const created = await client.callTool({ name: "create_workflow", arguments: { definition } });
    expect(created.isError).not.toBe(true);
    const patch = {
      schemaVersion: "1",
      workflowId: definition.id,
      baseVersion: 1,
      operations: [{ op: "set_workflow_name", name: "Edited through MCP" }],
    };
    const edited = await client.callTool({ name: "apply_workflow_commands", arguments: patch });
    expect(edited.isError).not.toBe(true);
    const stale = await client.callTool({ name: "apply_workflow_commands", arguments: patch });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("workflow_version_conflict");
    const read = payload(
      await client.callTool({ name: "inspect_workflow", arguments: { workflowId: definition.id } }),
    );
    expect(read.versions.at(-1).definition.nodes[0].position).toEqual({ x: 240, y: 120 });
    writeFileSync(
      resolve(path, ".loopy/server.json"),
      JSON.stringify({
        pid: process.pid,
        url: server.url,
        token: server.token,
        projectDir: server.projectDir,
      }),
      { mode: 0o600 },
    );
    const stdio = new Client({ name: "loopy-stdio-test", version: "1" });
    try {
      await stdio.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve(import.meta.dir, "../../cli/src/index.ts"), "mcp", "--project", path],
          stderr: "pipe",
        }),
      );
      const snapshot = payload(
        await stdio.callTool({
          name: "inspect_workflow",
          arguments: { workflowId: definition.id },
        }),
      );
      expect(snapshot.versions.at(-1).version).toBe(2);
    } finally {
      await stdio.close();
    }
    const started = payload(
      await client.callTool({
        name: "start_run",
        arguments: { workflowId: definition.id, version: 2 },
      }),
    );
    await client.close();
    const completed = await server.runtime.wait(started.id);
    expect(completed.run.status).toBe("succeeded");
    expect(completed.attempts[0]?.output?.stdout).toBe("HELLO");
    const browserRead = await fetch(`${server.url}/api/v1/workflows/${definition.id}`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(
      (
        (await browserRead.json()) as { versions: Array<{ definition: { name: string } }> }
      ).versions.at(-1)?.definition.name,
    ).toBe("Edited through MCP");
  } finally {
    await client.close();
    await server.stop();
    rmSync(path, { recursive: true, force: true });
  }
}, 15_000);
