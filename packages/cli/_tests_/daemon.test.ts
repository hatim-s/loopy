import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { daemonUrl, localDaemon, readDaemonFile } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect, Exit, Scope } from "effect";
import { qualityTestRoot } from "../../runtime/_tests_/fixtures/quality-test-root";
import { onCleanup, runScoped } from "../../runtime/_tests_/fixtures/test-scope";
import { until } from "../../runtime/_tests_/fixtures/wait";
import { writeDaemonFile } from "../../runtime/src/local/daemon/file";
import { cli, spawnCli } from "./fixtures/cli";

function place() {
  return { home: qualityTestRoot("daemon-home"), cwd: qualityTestRoot("daemon-cwd") };
}

async function startInProcess({ home, cwd }: ReturnType<typeof place>, scope?: Scope.Scope) {
  const store = await runScoped(openRunStore(home), scope);

  const daemon = await runScoped(
    localDaemon({ home, cwd, store, port: 0, concurrency: 2, assets: join(cwd, "assets") }),
    scope,
  );

  return new URL(await runScoped(daemon.start, scope));
}

/** Spawns a foreground daemon that the test's scope stops if the test does not. */
function foreground(at: ReturnType<typeof place>, args: string[]) {
  const child = spawnCli(at, args, "ignore");

  onCleanup(async () => {
    child.kill();
    await child.exited;
  });

  return child;
}

test("ui and daemon status read the private discovery file, which clean shutdown removes", async () => {
  const at = place();
  const scope = Scope.makeUnsafe();
  onCleanup(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const url = await startInProcess(at, scope);
  expect(statSync(join(at.home, "daemon.json")).mode & 0o777).toBe(0o600);
  const record = readDaemonFile(at.home);
  expect(record).toMatchObject({
    pid: process.pid,
    port: Number(url.port),
    token: new URLSearchParams(url.hash.slice(1)).get("token"),
    startedAt: expect.any(String),
  });

  const ui = await cli(at, "ui");
  expect(ui.stdout.trim()).toBe(url.toString());
  expect(ui.code).toBe(0);

  const status = await cli(at, "daemon", "status");
  expect(JSON.parse(status.stdout)).toEqual(record);
  expect(status.code).toBe(0);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(existsSync(join(at.home, "daemon.json"))).toBe(false);
});

test("ui starts the foreground daemon when discovery is absent and removes it on SIGTERM", async () => {
  const at = place();
  const child = foreground(at, ["ui", "--port", "0"]);
  const record = await until("daemon discovery", () => readDaemonFile(at.home));
  expect(record.pid).toBe(child.pid);
  const reader = child.stdout.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value).trim()).toBe(daemonUrl(record));
  reader.releaseLock();
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  expect(existsSync(join(at.home, "daemon.json"))).toBe(false);
});

test("second foreground daemon reports an actionable error", async () => {
  const at = place();
  await startInProcess(at);
  const second = await cli(at, "daemon", "run", "--port", "0");
  expect(second.code).toBe(1);
  expect(second.stderr).toContain("A daemon is already running for this home");
  expect(readDaemonFile(at.home)?.pid).toBe(process.pid);
});

test("ui refuses an explicit port that differs from the running daemon", async () => {
  const at = place();
  writeDaemonFile(at.home, {
    pid: process.pid,
    port: 4999,
    token: "fixture-token",
    startedAt: new Date().toISOString(),
  });

  const ui = await cli(at, "ui", "--port", "5000");
  expect(ui.stderr).toContain("A daemon is already running on port 4999.");
  expect(ui.code).toBe(1);
});

test("daemon run stdout never contains its bearer token", async () => {
  const at = place();
  const child = foreground(at, ["daemon", "run", "--port", "0"]);
  const record = await until("daemon discovery", () => readDaemonFile(at.home));
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  const output = await new Response(child.stdout).text();
  expect(output).toContain(`http://127.0.0.1:${record.port}`);
  expect(output).toContain("loopy ui");
  expect(output).not.toContain(record.token);
});
