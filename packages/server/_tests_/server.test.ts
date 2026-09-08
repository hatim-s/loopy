import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkflowDefinitionSchema } from "@loopy/contracts";
import { openStorage } from "@loopy/storage";
import { startServer } from "../src/index";

const projects: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const fixture = await Bun.file(
  resolve(import.meta.dir, "../../../fixtures/workflows/valid-basic.json"),
).json();
function project() {
  const path = mkdtempSync(resolve(tmpdir(), "loopy-server-"));
  projects.push(path);
  writeFileSync(resolve(path, "index.html"), "<html><head></head><body>Loopy</body></html>");
  const definition = WorkflowDefinitionSchema.parse(fixture);
  const node = definition.nodes.find((node) => node.kind === "verify");
  if (!node) throw new Error("Fixture verification node is missing");
  definition.nodes = [node];
  definition.edges = [];
  definition.inputs = [];
  definition.policies.workspace = {
    useGitWorktree: false,
    allowDirtyWorkspace: true,
    writableRoots: [path],
  };
  if (node.kind === "verify")
    node.commands = [
      {
        command: process.execPath,
        args: ["-e", "await Bun.sleep(300); console.log('completed')"],
        timeoutMs: 5000,
      },
    ];
  const storage = openStorage({ projectDir: path });
  storage.runtime.createWorkflowVersion({ workflowId: definition.id, definition });
  storage.close();
  return { path, definition };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("serves authenticated runtime, rejects foreign hosts, and persists verification", async () => {
  const { path, definition } = project();
  const server = await startServer({ projectDir: path, studioDir: path });
  servers.push(server);
  const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
  expect((await fetch(`${server.url}/api/v1/runs`)).status).toBe(401);
  expect((await fetch(`${server.url}/`, { headers: { Host: "evil.example" } })).status).toBe(403);
  expect(
    (await fetch(`${server.url}/`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
  ).toBe(403);
  expect(await (await fetch(server.url)).text()).toContain("__LOOPY_STUDIO_SESSION__");
  const started = await fetch(`${server.url}/api/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workflowId: definition.id }),
  });
  expect(started.status).toBe(201);
  const run = (await started.json()) as { id: string };
  const result = await server.runtime.wait(run.id);
  expect(result.run.status).toBe("succeeded");
  expect(result.attempts[0]?.output).toMatchObject({
    commands: [{ exitCode: 0, stdout: "completed\n" }],
  });
  const history = (await (
    await fetch(`${server.url}/api/v1/runs/${run.id}`, { headers })
  ).json()) as { events: unknown[] };
  expect(history.events.length).toBeGreaterThan(2);
});
test("drains a node before closing SQLite, leaving its run paused for restart", async () => {
  const { path, definition } = project();
  const server = await startServer({ projectDir: path, studioDir: path });
  const response = await fetch(`${server.url}/api/v1/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ workflowId: definition.id }),
  });
  const { id } = (await response.json()) as { id: string };
  while (
    !(await server.runtime.snapshot(id)).attempts.some((attempt) => attempt.status === "running")
  )
    await Bun.sleep(10);
  await server.stop();
  const resumed = await startServer({ projectDir: path, studioDir: path });
  servers.push(resumed);
  const snapshot = await resumed.runtime.snapshot(id);
  expect(snapshot.run.status).toBe("paused");
  expect(snapshot.attempts[0]?.status).toBe("succeeded");
  await resumed.runtime.resume(id);
  expect((await resumed.runtime.wait(id)).run.status).toBe("succeeded");
  expect((await resumed.runtime.snapshot(id)).attempts).toHaveLength(1);
});
test("background server survives its CLI launcher and accepts runs from a later CLI", async () => {
  const { path, definition } = project();
  const cli = resolve(import.meta.dir, "../../cli/src/index.ts");
  const command = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, cli, ...args, "--project", path, "--studio-dir", path],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    return stdout;
  };
  try {
    const state = JSON.parse(await command("server", "start")) as { pid: number; url: string };
    expect(state.pid).not.toBe(process.pid);
    expect(JSON.parse(await command("server", "status"))).toMatchObject({
      running: true,
      pid: state.pid,
    });
    const run = JSON.parse(await command("run", definition.id, "--json")) as { id: string };
    const secret = (await Bun.file(resolve(path, ".loopy/server.json")).json()) as {
      token: string;
    };
    let status = "running";
    for (let attempt = 0; attempt < 100 && status !== "succeeded"; attempt++) {
      const snapshot = (await (
        await fetch(`${state.url}/api/v1/runs/${run.id}`, {
          headers: { Authorization: `Bearer ${secret.token}` },
        })
      ).json()) as { status: string };
      status = snapshot.status;
      await Bun.sleep(20);
    }
    expect(status).toBe("succeeded");
  } finally {
    await command("server", "stop");
  }
}, 15_000);

test("restart rotates the token and same-origin reload supplies a new session", async () => {
  const { path } = project();
  const original = await startServer({ projectDir: path, studioDir: path });
  const oldToken = original.token;
  await original.stop();
  const restarted = await startServer({ projectDir: path, studioDir: path });
  servers.push(restarted);
  expect(restarted.token).not.toBe(oldToken);
  const stale = await fetch(`${restarted.url}/api/v1/health`, {
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  expect(stale.status).toBe(401);
  expect((await stale.json()).error.message).toContain("Reload Studio");
  const page = await fetch(restarted.url, { headers: { "Sec-Fetch-Site": "same-origin" } });
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain(restarted.token);
  expect((await fetch(restarted.url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
    403,
  );
  expect(
    (
      await fetch(`${restarted.url}/api/v1/health`, {
        headers: { Authorization: `Bearer ${restarted.token}` },
      })
    ).status,
  ).toBe(200);
});
