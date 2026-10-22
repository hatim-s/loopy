import { chmod, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  api,
  environment,
  owner,
  root,
  runtime,
  sandbox,
  sandboxState,
  state,
} from "./failures-config.js";
import { docker, ownedContainer, stop } from "./failures-resources.js";
import { assert } from "./journey-client.js";

export class FailureStack {
  readonly token = crypto.randomUUID() + crypto.randomUUID();
  readonly sandboxToken = crypto.randomUUID() + crypto.randomUUID();
  private worker?: ReturnType<typeof Bun.spawn>;
  private provider?: ReturnType<typeof Bun.spawn>;
  private generation = 0;
  private started = false;

  async start() {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    assert(
      !(await Bun.file(resolve(state, "processes.json")).exists()),
      "failure_stack_manifest_exists",
    );

    for (const port of [14970, 14971, 14973]) {
      await new Promise<void>((done, reject) => {
        const listener = createServer();
        listener.once("error", () => reject(new Error(`Port ${port} is occupied.`)));
        listener.listen(port, "127.0.0.1", () => listener.close(() => done()));
      });
    }

    await docker(["image", "inspect", "loopy-sandbox:bun-1.4.0", "--format", "{{.Id}}"]);
    const config = await Bun.file(resolve(root, "apps/cloud/wrangler.jsonc")).json();
    await Bun.write(
      resolve(state, "wrangler.json"),
      JSON.stringify({
        ...config,
        name: "loopy-cloud-failures-local",
        main: resolve(root, "apps/cloud/src/worker.ts"),
        vars: { ...config.vars, SANDBOX_URL: sandbox },
        dev: { ip: "127.0.0.1", port: 14970, inspector_port: 14973 },
      }),
    );
    const vars = resolve(state, "worker.dev.vars");
    await Bun.write(
      vars,
      `LOCAL_AUTH='${JSON.stringify([{ workspace: "fixtures", token: this.token }])}'\nSANDBOX_TOKEN=${JSON.stringify(this.sandboxToken)}\n`,
    );
    await chmod(vars, 0o600);
    this.started = true;
    this.launchProvider();
    this.launchWorker();
    await this.ready();
  }

  private launch(name: string, argv: string[], extra: Record<string, string> = {}) {
    return Bun.spawn(argv, {
      cwd: root,
      env: { ...environment, ...extra },
      stdin: "ignore",
      stdout: Bun.file(resolve(state, `${name}-${this.generation}.log`)),
      stderr: Bun.file(resolve(state, `${name}-${this.generation}.error.log`)),
    });
  }

  private launchProvider() {
    this.provider = this.launch(
      "sandbox",
      [
        process.execPath,
        "--no-env-file",
        resolve(root, "apps/sandbox/src/index.ts"),
        "--worktree",
        runtime,
        "--state-root",
        sandboxState,
        "--docker-context",
        "colima-loopy-cloud-phase1",
        "--image",
        "loopy-sandbox:bun-1.4.0",
        "--port",
        "14971",
      ],
      { LOOPY_SANDBOX_TOKEN: this.sandboxToken },
    );
  }

  private launchWorker() {
    this.worker = this.launch("worker", [
      process.execPath,
      "x",
      "--no-install",
      "wrangler",
      "dev",
      "--local",
      "--config",
      resolve(state, "wrangler.json"),
      "--persist-to",
      resolve(state, "wrangler"),
      "--env-file",
      resolve(state, "worker.dev.vars"),
    ]);
  }

  async ready() {
    const deadline = Date.now() + 45_000;

    while (Date.now() < deadline) {
      assert(
        this.worker?.exitCode === null && this.provider?.exitCode === null,
        "stack_child_exited",
      );

      try {
        const responses = await Promise.all([
          fetch(`${api}/api/runs`, {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(1000),
          }),
          fetch(`${sandbox}/health`, { signal: AbortSignal.timeout(1000) }),
        ]);

        const healthy = responses.every((response) => response.ok);
        await Promise.all(responses.map((response) => response.body?.cancel()));

        if (healthy) {
          await Bun.write(
            resolve(state, "processes.json"),
            JSON.stringify({
              owner: process.pid,
              worker: this.worker?.pid,
              provider: this.provider?.pid,
              root,
              sandboxState,
            }),
          );

          return;
        }
      } catch {
        // The owned services may still be binding their loopback ports.
      }

      await Bun.sleep(250);
    }

    throw new Error("Isolated stack readiness timed out. Inspect its local logs.");
  }

  async restart(downtimeMs = 0) {
    assert(this.worker && this.provider, "stack_not_started");
    const before = { worker: this.worker.pid, provider: this.provider.pid };
    await stop(this.worker, "SIGKILL");
    await stop(this.provider, "SIGKILL");
    await Bun.sleep(downtimeMs);
    this.generation += 1;
    this.launchProvider();
    this.launchWorker();
    await this.ready();

    return { before, after: { worker: this.worker?.pid, provider: this.provider?.pid } };
  }

  async close() {
    if (!this.started) {
      return { containersRemoved: 0, volumesRemoved: 0, ownedContainersRemaining: 0 };
    }

    if (this.worker) {
      await stop(this.worker, "SIGTERM");
    }

    if (this.provider) {
      await stop(this.provider, "SIGTERM");
    }

    const volumes = new Set<string>();

    const names = (
      await docker([
        "ps",
        "-a",
        "--filter",
        `label=loopy.sandbox.owner=${owner}`,
        "--format",
        "{{.Names}}",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const name of names) {
      const container = await ownedContainer(name);

      for (const mount of container.Mounts) {
        if (mount.Type === "volume" && mount.Name) {
          volumes.add(mount.Name);
        }
      }

      await docker(["rm", "--force", name]);
    }

    for (const volume of volumes) {
      assert(
        /^loopy-(workspace|input)-[a-f0-9]{64}$/.test(volume),
        "cleanup_volume_identity_mismatch",
      );
      await docker(["volume", "rm", volume]);
    }

    const remaining = await docker([
      "ps",
      "-a",
      "--filter",
      `label=loopy.sandbox.owner=${owner}`,
      "--format",
      "{{.Names}}",
    ]);

    assert(remaining.trim() === "", "owned_containers_remain");
    const { unlink } = await import("node:fs/promises");
    await unlink(resolve(state, "processes.json")).catch(() => undefined);

    return {
      containersRemoved: names.length,
      volumesRemoved: volumes.size,
      ownedContainersRemaining: 0,
    };
  }
}
