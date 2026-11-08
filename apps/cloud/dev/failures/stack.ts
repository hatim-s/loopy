import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";
import { assert } from "../shared/assert";
import { root } from "../stack/constants";
import { randomToken } from "../stack/credentials";
import {
  type Child,
  launch,
  requireSandboxImage,
  sandboxArgv,
  wranglerArgv,
} from "../stack/launch";
import { requireFreePorts } from "../stack/ports";
import { respondsOk, waitUntilReady } from "../stack/readiness";
import { writeDevVars, writeWorkerConfig } from "../stack/worker-config";
import { api, environment, ports, runtime, sandbox, sandboxState, state } from "./config";
import { owned, stop } from "./resources";

const manifestPath = resolve(state, "processes.json");

const workerConfig = resolve(state, "wrangler.json");

const devVars = resolve(state, "worker.dev.vars");

export class FailureStack {
  readonly token = randomToken();
  readonly sandboxToken = randomToken();
  private children: { worker: Child; provider: Child } | null = null;
  private generation = 0;
  private started = false;

  async start() {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    assert(!(await Bun.file(manifestPath).exists()), "failure_stack_manifest_exists");
    await requireFreePorts([ports.api, ports.sandbox, ports.inspector]);
    await requireSandboxImage(SANDBOX_IMAGE, environment);
    await writeWorkerConfig({
      path: workerConfig,
      name: "loopy-cloud-failures-local",
      vars: { SANDBOX_URL: sandbox },
      apiPort: ports.api,
      inspectorPort: ports.inspector,
    });
    await writeDevVars(devVars, {
      principals: [{ workspace: "fixtures", token: this.token }],
      sandboxToken: this.sandboxToken,
    });
    this.started = true;
    await this.launch();
  }

  // Restarts write new logs so the evidence keeps every generation's output.
  private async launch() {
    const log = (name: string) => `${name}-${this.generation}`;

    const provider = launch({
      argv: sandboxArgv({ worktree: runtime, port: ports.sandbox }),
      env: { ...environment, LOOPY_SANDBOX_TOKEN: this.sandboxToken },
      logs: state,
      log: log("sandbox"),
    });

    const worker = launch({
      argv: wranglerArgv({
        config: workerConfig,
        persistTo: resolve(state, "wrangler"),
        envFile: devVars,
      }),
      env: environment,
      logs: state,
      log: log("worker"),
    });

    this.children = { worker, provider };
    await waitUntilReady({
      children: [worker, provider],
      probes: [
        () => respondsOk(`${api}/api/runs`, { headers: { Authorization: `Bearer ${this.token}` } }),
        () => respondsOk(`${sandbox}/health`),
      ],
      timeoutMs: 45_000,
      intervalMs: 250,
      timeoutMessage: "Isolated stack readiness timed out. Inspect its local logs.",
    });
    await Bun.write(
      manifestPath,
      JSON.stringify({
        owner: process.pid,
        worker: worker.pid,
        provider: provider.pid,
        root,
        sandboxState,
      }),
    );
  }

  async restart(downtimeMs = 0) {
    assert(this.children, "stack_not_started");
    const { worker, provider } = this.children;
    const before = { worker: worker.pid, provider: provider.pid };
    await stop(worker, "SIGKILL");
    await stop(provider, "SIGKILL");
    await Bun.sleep(downtimeMs);
    this.generation += 1;
    await this.launch();

    return {
      before,
      after: { worker: this.children.worker.pid, provider: this.children.provider.pid },
    };
  }

  async close() {
    if (!this.started) {
      return;
    }

    if (this.children) {
      await stop(this.children.worker, "SIGTERM");
      await stop(this.children.provider, "SIGTERM");
    }

    const evidence = await owned.remove();
    await rm(manifestPath, { force: true });

    return evidence;
  }
}
