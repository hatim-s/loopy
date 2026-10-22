import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { boundedText } from "./modal-probe-gateway.js";
import { type Journal, readPrivate } from "./modal-probe-journal.js";
import { type Action, approvalSchema, authorize, implementationHash } from "./modal-probe-plan.js";

export function workerEnvironment(config: string, environment: string) {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    MODAL_CONFIG_PATH: config,
    MODAL_ENVIRONMENT: environment,
    MODAL_SERVER_URL: "https://api.modal.com:443",
    MODAL_SANDBOX_V2: "false",
    LOOPY_MODAL_PROBE_WORKER: "1",
  };
}

export async function watchChild(
  child: Pick<Bun.Subprocess<"ignore", "pipe", "ignore">, "exited" | "stdout" | "kill">,
  budgetMs: number,
): Promise<string> {
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, budgetMs);

  try {
    const output = boundedText(child.stdout.pipeThrough(new TextDecoderStream()), 8192);
    const [code, text] = await Promise.all([child.exited, output]);

    if (timedOut || code !== 0) {
      throw new Error(timedOut ? "worker-watchdog-expired" : "worker-failed-see-journal");
    }

    return text;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}

export async function supervise(
  journal: Journal,
  action: Action,
  approvalFile: string,
  credentialsFile: string,
): Promise<string> {
  authorize(await readPrivate(approvalFile, approvalSchema), journal.manifest, {
    action,
    now: Date.now(),
    implementationHash: await implementationHash(import.meta.dir),
  });

  const lockPath = join(journal.directory, "operation.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const config = join(journal.directory, "empty-modal-config.toml");

  try {
    const file = await open(
      config,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );

    await file.close();
    const deadline = Date.now() + journal.manifest.bounds.wallTimeMs;

    const run = (mode: Action | "verify", budget: number) =>
      watchChild(
        Bun.spawn({
          cmd: [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "modal-probe-worker.ts"),
            mode,
            journal.manifest.id,
            approvalFile,
            credentialsFile,
          ],
          cwd: process.cwd(),
          env: workerEnvironment(config, journal.manifest.target.environment),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
        Math.min(budget, Math.max(1, deadline - Date.now())),
      );

    if (action !== "execute") {
      return await run(action, 30000);
    }

    try {
      await run("execute", 170000);
      // No child or SDK client exists during this interval.
      await Bun.sleep(17000);
      await run("verify", 15000);
    } finally {
      const report = await run("stop", 30000);
      process.stdout.write(report);
    }

    return "probe-completed-see-journal\n";
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
