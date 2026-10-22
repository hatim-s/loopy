import { createHash } from "node:crypto";
import type { SandboxConfig } from "./config.js";
import { type CommandRunner, runCommand } from "./process.js";

type CaptureLimits = { timeoutMs?: number; maxBytes?: number };

export class DockerClient {
  readonly owner: string;
  constructor(
    private readonly config: SandboxConfig,
    private readonly runner: CommandRunner = runCommand,
    private readonly signal?: AbortSignal,
  ) {
    this.owner = createHash("sha256").update(config.stateRoot).digest("hex");
  }

  call(args: string[], limits: CaptureLimits = {}) {
    return this.runner(["docker", "--context", this.config.dockerContext, ...args], {
      timeoutMs: limits.timeoutMs ?? 30_000,
      maxBytes: limits.maxBytes ?? 64 * 1024,
      signal: this.signal,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? this.config.worktree,
        LANG: "C.UTF-8",
      },
    });
  }

  async required(args: string[], limits?: CaptureLimits) {
    const output = await this.call(args, limits);

    if (output.exitCode !== 0) {
      throw new Error(`Docker ${args[0]} failed. Inspect the selected Docker context.`);
    }

    return output;
  }
}
