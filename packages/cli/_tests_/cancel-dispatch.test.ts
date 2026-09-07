import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainAsync } from "../src/index.ts";

test("daemon run controls send action-specific bodies and preserve cancellation reason", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-dispatch-")));
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/server"))
        return Response.json({ product: "Loopy", pid: process.pid, projectDir: root });
      calls.push({ path, body: await request.json() });
      return Response.json({ status: "cancelled" });
    },
  });
  try {
    mkdirSync(join(root, ".loopy"));
    writeFileSync(
      join(root, ".loopy/server.json"),
      JSON.stringify({
        pid: process.pid,
        url: `http://127.0.0.1:${server.port}`,
        token: "test",
        projectDir: root,
      }),
    );
    await mainAsync(["cancel", "run-id", "--reason", "deployment stopped", "--project", root]);
    await mainAsync(["pause", "run-id", "--input", "invalid-json", "--project", root]);
    expect(calls).toEqual([
      { path: "/api/v1/runs/run-id/cancel", body: { reason: "deployment stopped" } },
      { path: "/api/v1/runs/run-id/pause", body: {} },
    ]);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
