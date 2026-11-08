import { Effect } from "effect";
import type { SandboxConfig } from "../config";
import { failure } from "../operations";
import { type CommandRunner, runCommand } from "../process";
import { type ContainerRole, labelArgs, ownerOf, ownsLabels } from "./identity";

type CallOptions = { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal };

export class DockerClient {
  readonly owner: string;
  constructor(
    private readonly config: Pick<SandboxConfig, "stateRoot" | "dockerContext" | "worktree">,
    private readonly runner: CommandRunner = runCommand,
  ) {
    this.owner = ownerOf(config.stateRoot);
  }

  call(args: string[], options: CallOptions = {}) {
    return this.runner(["docker", "--context", this.config.dockerContext, ...args], {
      cwd: this.config.worktree,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 64 * 1024,
      signal: options.signal,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? this.config.worktree,
        LANG: "C.UTF-8",
      },
    });
  }

  required(args: string[], options?: CallOptions) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* this.call(args, options);

      if (output.exitCode !== 0) {
        return yield* Effect.fail(
          failure(
            "Docker command",
            new Error(`Docker ${args[0]} failed. Inspect the selected Docker context.`),
          ),
        );
      }

      return output;
    });
  }

  exists(container: string, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const listed = (yield* this.required(
        ["container", "ls", "--all", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"],
        { signal },
      )).stdout.trim();

      if (listed !== "" && listed !== container) {
        return yield* Effect.fail(
          failure("docker", new Error("Docker listed a container under a different name.")),
        );
      }

      return listed === container;
    });
  }

  labels(requestHash: string, role?: ContainerRole) {
    return labelArgs(this.owner, requestHash, role);
  }

  owns(labels: Record<string, string>, requestHash: string, role?: ContainerRole) {
    return ownsLabels(labels, this.owner, requestHash, role);
  }
}
