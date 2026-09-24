import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/command.ts";
import { Registry } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { trigger } from "../src/workflow.ts";

const temporary: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "loopy-product-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const cliPath = join(import.meta.dir, "../src/cli.ts");
async function cli(home: string, cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cliPath, ...args, "--home", home], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("CLI saves TypeScript and resumes failed steps from the original snapshot", async () => {
  const cwd = directory();
  const home = directory();
  const source = join(cwd, "checkpoint.loopy.ts");
  const modulePath = join(import.meta.dir, "../src/index.ts");
  writeFileSync(
    source,
    `import { trigger, command } from ${JSON.stringify(modulePath)};
export default trigger('checkpoint')
 .node('once', command(${JSON.stringify(process.execPath)}, '-e', "require('node:fs').appendFileSync('count','x')"))
 .node('finish', command(${JSON.stringify(process.execPath)}, '-e', "if(!require('node:fs').existsSync('ready')) process.exit(7); console.log('done')"));`,
  );
  const saved = await cli(home, cwd, "save", source);
  expect(saved.exitCode).toBe(0);
  const failed = await cli(home, cwd, "run", "checkpoint", "--full");
  expect(failed.exitCode).toBe(1);
  const run = JSON.parse(failed.stdout);
  expect(run.status).toBe("failed");
  expect(readFileSync(join(cwd, "count"), "utf8")).toBe("x");

  new Registry(home).save(
    trigger("checkpoint").node("different", command("not-a-real-cli")).build(),
    source,
  );
  writeFileSync(join(cwd, "ready"), "yes");
  const resumed = await cli(home, cwd, "resume", run.id);
  expect(resumed.exitCode).toBe(0);
  expect(JSON.parse(resumed.stdout).workflowHash).toBe(run.workflowHash);
  expect(readFileSync(join(cwd, "count"), "utf8")).toBe("x");
  const detail = JSON.parse((await cli(home, cwd, "inspect", run.id)).stdout);
  expect(detail.attempts.map((attempt: { status: string }) => attempt.status)).toEqual([
    "succeeded",
    "failed",
    "succeeded",
  ]);
  expect(detail.attempts[2].output.stdout).toBe("done\n");
  expect(detail.events.map((event: { sequence: number }) => event.sequence)).toEqual(
    detail.events.map((_: unknown, index: number) => index),
  );
});

test("local API requires authorization and origin checks, runs saved workflows, and has no edit endpoint", async () => {
  const cwd = directory();
  const home = directory();
  const assets = directory();
  writeFileSync(join(assets, "index.html"), "Viewer");
  writeFileSync(join(home, "secret"), "Outside assets");
  symlinkSync(join(home, "secret"), join(assets, "leak"));
  new Registry(home).save(
    trigger("hello").node("greet", command("/bin/echo", "hello")).build(),
    "hello.ts",
  );
  const server = startServer({ home, cwd, assets, port: 0 });
  servers.push(server);
  writeFileSync(join(assets, "index.html"), "Changed after server started");
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const endpoint = (path: string) => `${url.origin}/api${path}`;
  expect(await (await fetch(url.origin)).text()).toBe("Viewer");
  expect((await fetch(`${url.origin}/leak`)).status).toBe(404);
  expect((await fetch(endpoint("/workflows"))).status).toBe(401);
  expect(
    (
      await fetch(endpoint("/workflows"), {
        headers: { ...headers, Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(endpoint("/workflows/hello/patch"), { method: "POST", headers, body: "{}" }))
      .status,
  ).toBe(404);
  const started = await fetch(endpoint("/runs"), {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "hello", input: null, mode: "full" }),
  });
  expect(started.status).toBe(202);
  const run = (await started.json()) as { id: string };
  let detail:
    | { run: { status: string; input: unknown }; attempts: { output?: { stdout: string } }[] }
    | undefined;
  for (let i = 0; i < 100; i++) {
    detail = (await (
      await fetch(endpoint(`/runs/${run.id}`), { headers })
    ).json()) as typeof detail;
    if (detail?.run.status === "succeeded") break;
    await Bun.sleep(10);
  }
  expect(detail?.run.status).toBe("succeeded");
  expect(detail?.run.input).toBeNull();
  expect(detail?.attempts[0]?.output?.stdout).toBe("hello\n");
});
