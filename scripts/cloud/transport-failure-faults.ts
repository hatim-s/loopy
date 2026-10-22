import { resolve } from "node:path";
import type { CommandRunner, ProcessOptions } from "../../apps/sandbox/src/process.js";
import { runCommand } from "../../apps/sandbox/src/process.js";
import { assert, equal } from "./journey-client.js";
import {
  type Config,
  marker,
  oneReceipt,
  ownedContainer,
  ownerOf,
  until,
} from "./transport-failure-resources.js";

export type FaultMode = "kill_wait_client" | "unavailable_inspect_socket";

export class TransportFaults {
  readonly events: {
    operation: string;
    exitCode: number;
    at: string;
    pid?: number;
    signal?: string;
    workerRunning?: boolean;
    stderr?: string;
  }[] = [];
  readonly waitPids: number[] = [];
  readonly calls: { operation: string; args: string[]; at: number }[] = [];
  private outage = false;
  private killedWait = false;
  activeCalls = 0;

  constructor(
    private readonly config: Config,
    readonly mode: FaultMode,
  ) {}

  restore() {
    this.outage = false;
  }

  readonly runner: CommandRunner = async (argv, options) => {
    equal(
      argv.slice(0, 3),
      ["docker", "--context", this.config.dockerContext],
      "unexpected_docker_target",
    );
    const operation = argv.slice(3, argv[3] === "container" ? 5 : 4).join(" ");
    this.calls.push({ operation, args: argv.slice(3), at: Date.now() });
    this.activeCalls += 1;

    try {
      if (operation === "wait" && this.mode === "kill_wait_client" && !this.killedWait) {
        return await this.killWait(argv, options);
      }

      if (
        operation === "container inspect" &&
        this.mode === "unavailable_inspect_socket" &&
        this.events.length === 0
      ) {
        this.outage = true;
      }

      if (this.outage && ["container inspect", "container ls"].includes(operation)) {
        // Only this invocation sees the absent socket. The selected context and daemon stay intact.
        const socket = `/var/empty/loopy-transport-${ownerOf(this.config).slice(0, 16)}.sock`;

        const output = await runCommand(
          [argv[0] ?? "docker", "--host", `unix://${socket}`, ...argv.slice(3)],
          options,
        );

        assert(output.exitCode !== 0, "isolated_socket_unexpectedly_available");
        assert(output.stderr.includes(socket), "cli_did_not_report_isolated_socket");
        const saved = await oneReceipt(this.config);
        const running = (await ownedContainer(this.config, saved)).State.Running;
        assert(running, "worker_stopped_during_inspect_failure");
        this.events.push({
          operation,
          exitCode: output.exitCode,
          stderr: output.stderr.trim(),
          at: new Date().toISOString(),
          workerRunning: running,
        });

        return output;
      }

      return await runCommand(argv, options);
    } finally {
      this.activeCalls -= 1;
    }
  };

  private async killWait(argv: string[], options: ProcessOptions) {
    this.killedWait = true;
    const saved = await oneReceipt(this.config);
    await until(
      () => marker(saved),
      (text) => text === "started\n",
    );
    const started = Date.now();

    const child = Bun.spawn(argv, {
      cwd: options.cwd ?? resolve(this.config.worktree),
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.waitPids.push(child.pid);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();

    try {
      await Bun.sleep(200);
      assert(child.exitCode === null, "wait_client_not_in_flight");
      assert(
        (await ownedContainer(this.config, saved)).State.Running,
        "worker_not_running_before_wait_kill",
      );
      child.kill("SIGKILL");
      const exitCode = await child.exited;
      assert(exitCode !== 0, "wait_client_kill_succeeded_unexpectedly");
      const running = (await ownedContainer(this.config, saved)).State.Running;
      assert(running, "worker_stopped_with_wait_client");
      this.events.push({
        operation: "wait",
        exitCode,
        pid: child.pid,
        signal: "SIGKILL",
        at: new Date().toISOString(),
        workerRunning: running,
      });
      this.outage = true;

      return {
        stdout: await stdout,
        stderr: await stderr,
        exitCode,
        durationMs: Date.now() - started,
      };
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }

      await Promise.all([child.exited, stdout, stderr]);
    }
  }
}
