import { resolve } from "node:path";
import { DOCKER_CONTEXT, root, SANDBOX_IMAGE } from "./constants";

export type Child = ReturnType<typeof Bun.spawn>;

export function launch(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  logs: string;
  log: string;
}): Child {
  return Bun.spawn(options.argv, {
    cwd: root,
    env: options.env,
    stdin: "ignore",
    stdout: Bun.file(resolve(options.logs, `${options.log}.log`)),
    stderr: Bun.file(resolve(options.logs, `${options.log}.error.log`)),
  });
}

export function sandboxArgv(options: { worktree: string; stateRoot: string; port: number }) {
  return [
    process.execPath,
    "--no-env-file",
    resolve(root, "apps/sandbox/src/index.ts"),
    "--worktree",
    options.worktree,
    "--state-root",
    options.stateRoot,
    "--docker-context",
    DOCKER_CONTEXT,
    "--image",
    SANDBOX_IMAGE,
    "--port",
    String(options.port),
  ];
}

export function wranglerArgv(options: { config: string; persistTo: string; envFile: string }) {
  return [
    process.execPath,
    "x",
    "--no-install",
    "wrangler",
    "dev",
    "--local",
    "--config",
    options.config,
    "--persist-to",
    options.persistTo,
    "--env-file",
    options.envFile,
  ];
}

export function dashboardArgv(port: number) {
  return [
    process.execPath,
    "run",
    "--cwd",
    "apps/dashboard",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
}

export async function requireSandboxImage(image: string, env: Record<string, string | undefined>) {
  const inspection = Bun.spawn(
    ["docker", "--context", DOCKER_CONTEXT, "image", "inspect", image, "--format", "{{.Id}}"],
    { env, stdout: "ignore", stderr: "ignore" },
  );

  if ((await inspection.exited) !== 0) {
    throw new Error(
      `Docker image ${image} is unavailable in context ${DOCKER_CONTEXT}. Run bun run cloud:build-sandbox. No services started.`,
    );
  }
}
