import { resolve } from "node:path";
import { Effect } from "effect";
import type { CommandRunner, ProcessOptions } from "../../../sandbox/src/process";
import { runCommand } from "../../../sandbox/src/process";
import { fixtureIO } from "../fixture-effect";
import { assert, equal } from "../journey/client";
import { withWaitClient } from "../wait-client";
import { type Config, marker, oneReceipt, ownedContainer, ownerOf, until } from "./resources";

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
    private readonly commandRunner: CommandRunner = runCommand,
  ) {}

  restore() {
    this.outage = false;
  }

  readonly runner: CommandRunner = (argv, options) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        equal(
          argv.slice(0, 3),
          ["docker", "--context", this.config.dockerContext],
          "unexpected_docker_target",
        );
        const operation = argv.slice(3, argv[3] === "container" ? 5 : 4).join(" ");
        this.calls.push({ operation, args: argv.slice(3), at: Date.now() });
        this.activeCalls += 1;

        return yield* restore(
          Effect.gen({ self: this }, function* () {
            if (operation === "wait" && this.mode === "kill_wait_client" && !this.killedWait) {
              return yield* this.killWait(argv, options);
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

              const output = yield* this.commandRunner(
                [argv[0] ?? "docker", "--host", `unix://${socket}`, ...argv.slice(3)],
                options,
              );

              assert(output.exitCode !== 0, "isolated_socket_unexpectedly_available");
              assert(output.stderr.includes(socket), "cli_did_not_report_isolated_socket");
              const saved = yield* oneReceipt(this.config).pipe(Effect.orDie);

              const running = (yield* ownedContainer(this.config, saved).pipe(Effect.orDie)).State
                .Running;

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

            return yield* this.commandRunner(argv, options);
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.activeCalls -= 1;
            }),
          ),
        );
      }),
    );

  private killWait(argv: string[], options: ProcessOptions) {
    return Effect.gen({ self: this }, function* () {
      this.killedWait = true;
      const saved = yield* oneReceipt(this.config).pipe(Effect.orDie);
      yield* until(
        () => marker(saved),
        (text) => text === "started\n",
      ).pipe(Effect.orDie);
      const started = Date.now();

      return yield* withWaitClient(
        Effect.sync(() => {
          const child = Bun.spawn(argv, {
            cwd: options.cwd ?? resolve(this.config.worktree),
            env: options.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });

          this.waitPids.push(child.pid);

          return {
            pid: child.pid,
            get exitCode() {
              return child.exitCode;
            },
            kill: () => {
              child.kill("SIGKILL");
            },
            exited: child.exited,
            stdout: new Response(child.stdout).text(),
            stderr: new Response(child.stderr).text(),
          };
        }),
        (child) =>
          Effect.gen({ self: this }, function* () {
            yield* Effect.sleep(200);
            assert(child.exitCode === null, "wait_client_not_in_flight");
            assert(
              (yield* ownedContainer(this.config, saved).pipe(Effect.orDie)).State.Running,
              "worker_not_running_before_wait_kill",
            );
            child.kill();

            const exitCode = yield* fixtureIO("wait client exit", () => child.exited).pipe(
              Effect.orDie,
            );

            assert(exitCode !== 0, "wait_client_kill_succeeded_unexpectedly");

            const running = (yield* ownedContainer(this.config, saved).pipe(Effect.orDie)).State
              .Running;

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
              stdout: yield* fixtureIO("stdout", () => child.stdout).pipe(Effect.orDie),
              stderr: yield* fixtureIO("stderr", () => child.stderr).pipe(Effect.orDie),
              exitCode,
              durationMs: Date.now() - started,
            };
          }),
      );
    });
  }
}
