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
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createProjectCatalog, type ProjectManager, projectPath, startServer } from "@loopy/server";
import { createLoginService } from "./login-service";

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
export async function serverRequest(
  state: ServerState,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${state.url}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
export function createProjectManager(
  project: string,
  studioDir: string,
  home = process.env.LOOPY_HOME ?? resolve(homedir(), ".loopy"),
): ProjectManager {
  const catalog = createProjectCatalog(home);
  const opening = new Map<string, ReturnType<ProjectManager["open"]>>();
  return {
    async list() {
      const current = catalog.remember(project);
      const projects = await Promise.all(
        catalog.list().map(async (entry) => {
          const state = await runningServer(entry.path).catch(() => undefined);
          return {
            ...entry,
            current: entry.id === current.id,
            running: !!state,
            ...(state ? { url: state.url } : {}),
          };
        }),
      );
      return { current: current.id, projects };
    },
    open(path) {
      catalog.remember(project);
      const canonical = projectPath(path);
      const existing = opening.get(canonical);
      if (existing) return existing;
      const operation = (async () => {
        await serverCommand(["server", "start", "--project", canonical], studioDir, () => {});
        const state = await runningServer(canonical);
        if (!state) throw new Error("Project server did not become ready");
        return { url: state.url, project: catalog.remember(canonical) };
      })();
      opening.set(canonical, operation);
      void operation.finally(() => opening.delete(canonical)).catch(() => {});
      return operation;
    },
    forget(id) {
      catalog.forget(id);
    },
  };
}
export async function projectsCommand(args: readonly string[], studioDir: string) {
  const project = projectPath(option(args, "--project") ?? process.cwd());
  const manager = createProjectManager(project, studioDir);
  const action = args[1] ?? "list";
  if (action === "list") console.log(JSON.stringify(await manager.list()));
  else if (action === "open" && args[2] && !args[2].startsWith("--"))
    console.log(JSON.stringify(await manager.open(args[2])));
  else if (action === "forget" && args[2] && !args[2].startsWith("--")) {
    manager.forget(args[2]);
    console.log("Project removed from the list. Its files and server remain available.");
  } else
    throw new Error("Usage: loopy projects <list|open /absolute/path|forget id> [--project path]");
  return 0;
}
export async function serverCommand(
  args: readonly string[],
  studioDir: string,
  report: (text: string) => void = console.log,
): Promise<number> {
  const project = realpathSync(option(args, "--project") ?? process.cwd());
  const command = args[1] ?? "status";
  const current = await runningServer(project);
  const login = createLoginService(project);
  const publicState = (state: ServerState) => ({
    pid: state.pid,
    url: state.url,
    projectDir: project,
  });
  if (command === "status") {
    report(
      JSON.stringify(
        current
          ? { running: true, ...publicState(current), autostart: await login.status() }
          : { running: false, projectDir: project, autostart: await login.status() },
      ),
    );
    return current ? 0 : 1;
  }
  if (command === "logs") {
    report(resolve(project, ".loopy/server.log"));
    return 0;
  }
  let loginDefinition: string | undefined;
  if (command === "enable-autostart") {
    if (!existsSync(resolve(studioDir, "index.html")))
      throw new Error("Build Studio before starting: bun run --cwd apps/studio build");
    loginDefinition = login.prepare({
      executable: realpathSync(process.execPath),
      cli: realpathSync(process.argv[1] as string),
      studioDir: realpathSync(studioDir),
      path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      port: option(args, "--port"),
    });
    if (login.installed() && current) {
      report(JSON.stringify({ ...publicState(current), autostart: await login.status() }));
      return 0;
    }
  }
  if (command === "disable-autostart" && !login.installed()) {
    // Also report unsupported platforms without stopping their detached server.
    await login.uninstall();
    report("Login auto-start is already disabled.");
    return 0;
  }
  if (["stop", "restart", "enable-autostart", "disable-autostart"].includes(command)) {
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
      report("Loopy server stopped.");
      return 0;
    }
  }
  if (command === "disable-autostart") {
    await login.uninstall();
    report("Login auto-start disabled. Loopy server stopped.");
    return 0;
  }
  if (command === "start" || command === "restart" || command === "enable-autostart") {
    if (current && command === "start") {
      report(JSON.stringify(publicState(current)));
      return 0;
    }
    const previous = readState(project);
    if (previous && alive(previous.pid))
      throw new Error("Server owner is still alive. Inspect the server log.");
    if (!existsSync(resolve(studioDir, "index.html")))
      throw new Error("Build Studio before starting: bun run --cwd apps/studio build");
    mkdirSync(resolve(project, ".loopy"), { recursive: true, mode: 0o700 });
    if (loginDefinition || login.installed()) {
      if (loginDefinition) await login.install(loginDefinition);
      else await login.start();
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await runningServer(project);
        if (state) {
          report(JSON.stringify({ ...publicState(state), autostart: await login.status() }));
          return 0;
        }
        await Bun.sleep(100);
      }
      throw new Error(
        `Login service did not become ready. Read ${resolve(project, ".loopy/server.log")}`,
      );
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
        report(JSON.stringify(publicState(state)));
        return 0;
      }
      if (child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    throw new Error(`Server did not become ready. Read ${resolve(project, ".loopy/server.log")}`);
  }
  if (command === "serve") {
    if (current) throw new Error("A Loopy server already owns this project");
    const previous = readState(project);
    if (previous && alive(previous.pid))
      throw new Error("Server owner is still alive. Inspect the server log.");
    // launchd invokes serve directly after a crash. Reclaim only its proven dead owner's lock.
    const lockPath = resolve(project, ".loopy/loopy.lock");
    if (previous && existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (lock.pid === previous.pid) rmSync(lockPath);
    }
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
      projects: createProjectManager(project, studioDir),
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
    report(`Loopy server listening at ${server.url}`);
    return 0;
  }
  throw new Error(
    "Usage: loopy server <start|serve|status|stop|restart|logs|enable-autostart|disable-autostart> [--project path] [--port port]",
  );
}
