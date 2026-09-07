import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { startServer } from "@loopy/server";

type ServerState = { pid: number; url: string; token: string; projectDir: string };
const statePath = (project: string) => resolve(project, ".loopy/server.json");
const option = (args: readonly string[], name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
function readState(project: string): ServerState | undefined {
  try {
    const state = JSON.parse(readFileSync(statePath(project), "utf8")) as ServerState;
    const url = new URL(state.url);
    if (
      state.projectDir !== project ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 1 ||
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "http:" ||
      typeof state.token !== "string"
    )
      return undefined;
    return state;
  } catch {
    return undefined;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function runningServer(projectDir: string) {
  const project = realpathSync(projectDir);
  const state = readState(project);
  if (!state) return undefined;
  try {
    const response = await fetch(`${state.url}/api/v1/server`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(500),
    });
    const health = (await response.json()) as {
      product?: string;
      pid?: number;
      projectDir?: string;
    };
    if (
      response.ok &&
      health.product === "Loopy" &&
      health.pid === state.pid &&
      health.projectDir === project
    )
      return state;
  } catch {
    /* The owner may still be starting or stopping. */
  }
  return undefined;
}
export async function serverRequest(state: ServerState, path: string, body?: unknown) {
  const response = await fetch(`${state.url}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
export async function serverCommand(args: readonly string[], studioDir: string): Promise<number> {
  const project = realpathSync(option(args, "--project") ?? process.cwd());
  const command = args[1] ?? "status";
  const current = await runningServer(project);
  const publicState = (state: ServerState) => ({
    pid: state.pid,
    url: state.url,
    projectDir: project,
  });
  if (command === "status") {
    console.log(
      JSON.stringify(
        current
          ? { running: true, ...publicState(current) }
          : { running: false, projectDir: project },
      ),
    );
    return current ? 0 : 1;
  }
  if (command === "logs") {
    console.log(resolve(project, ".loopy/server.log"));
    return 0;
  }
  if (command === "stop" || command === "restart") {
    if (current) {
      await serverRequest(current, "/server/stop", {});
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!alive(current.pid)) break;
        await Bun.sleep(100);
      }
      if (alive(current.pid))
        throw new Error("Server is draining active nodes. Check server status before restarting.");
    } else if (readState(project) && alive(readState(project)?.pid ?? 0)) {
      throw new Error("Server owner is alive but unavailable; no signal was sent.");
    }
    if (command === "stop") {
      console.log("Loopy server stopped.");
      return 0;
    }
  }
  if (command === "start" || command === "restart") {
    if (current && command === "start") {
      console.log(JSON.stringify(publicState(current)));
      return 0;
    }
    const previous = readState(project);
    if (previous && alive(previous.pid))
      throw new Error("Server owner is still alive. Inspect the server log.");
    if (!existsSync(resolve(studioDir, "index.html")))
      throw new Error("Build Studio before starting: bun run --cwd apps/studio build");
    mkdirSync(resolve(project, ".loopy"), { recursive: true, mode: 0o700 });
    // Only reclaim a lock whose dead owner matches our persisted server identity.
    const lockPath = resolve(project, ".loopy/loopy.lock");
    if (previous && existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (lock.pid === previous.pid) rmSync(lockPath);
    }
    const log = openSync(resolve(project, ".loopy/server.log"), "a", 0o600);
    const port = option(args, "--port");
    const child = spawn(
      process.execPath,
      [
        process.argv[1] as string,
        "server",
        "serve",
        "--project",
        project,
        "--studio-dir",
        studioDir,
        ...(port ? ["--port", port] : []),
      ],
      {
        cwd: project,
        detached: true,
        stdio: ["ignore", log, log],
      },
    );
    closeSync(log);
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      const state = await runningServer(project);
      if (state) {
        console.log(JSON.stringify(publicState(state)));
        return 0;
      }
      if (child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    throw new Error(`Server did not become ready. Read ${resolve(project, ".loopy/server.log")}`);
  }
  if (command === "serve") {
    if (current) throw new Error("A Loopy server already owns this project");
    let server: Awaited<ReturnType<typeof startServer>>;
    const cleanup = () => {
      if (readState(project)?.pid === process.pid) rmSync(statePath(project), { force: true });
      process.exitCode = 0;
    };
    server = await startServer({
      projectDir: project,
      studioDir,
      port: option(args, "--port") ? Number(option(args, "--port")) : undefined,
      onShutdown: cleanup,
    });
    writeFileSync(
      statePath(project),
      JSON.stringify({
        pid: process.pid,
        url: server.url,
        token: server.token,
        projectDir: project,
      }),
      { mode: 0o600 },
    );
    const shutdown = () => {
      void server
        .stop()
        .then(cleanup)
        .catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.log(`Loopy server listening at ${server.url}`);
    return 0;
  }
  throw new Error(
    "Usage: loopy server <start|serve|status|stop|restart|logs> [--project path] [--port port]",
  );
}
