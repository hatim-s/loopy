import { expect, test } from "bun:test";
import type { DockerAttemptPlan } from "@loopy/contract/sandbox";
import { CommandExecutionError } from "@loopy/runtime/os";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Attempts } from "../src/attempt";
import type { SandboxConfig } from "../src/config";
import { type AttemptBackend, DockerBackend } from "../src/docker";
import { DockerClient } from "../src/docker/client";
import { ownerOf } from "../src/docker/identity";
import type { CommandRunner } from "../src/process";
import {
  attemptServices,
  dependencies,
  diskReceipts,
  fixture,
  request,
  succeeded,
} from "./fixtures/attempts";
import { run } from "./fixtures/run";

const { services, open } = attemptServices();

function dockerBackend(config: SandboxConfig, runner: CommandRunner) {
  return new DockerBackend(config, new DockerClient(config, runner));
}

async function capturedReceipt() {
  const config = await fixture();
  let saved: DockerAttemptPlan | undefined;

  const service = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        saved = plan;

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const input = request();
  await run(service.start(input));
  await run(service.drain());

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  return { config, saved, input };
}

function dockerState(
  config: SandboxConfig,
  saved: DockerAttemptPlan,
  running: boolean,
  exitCode = 0,
) {
  return JSON.stringify([
    {
      Config: {
        Labels: {
          "loopy.sandbox.owner": ownerOf(config.stateRoot),
          "loopy.sandbox.request": saved.requestHash,
        },
      },
      State: {
        Status: running ? "running" : "exited",
        Running: running,
        ExitCode: exitCode,
        OOMKilled: false,
      },
    },
  ]);
}

test("Docker create enforces isolation and recovery reads the original bounded result", async () => {
  const { config, saved, input } = await capturedReceipt();
  const calls: string[][] = [];
  const environments: (Record<string, string> | undefined)[] = [];

  const runner: CommandRunner = (argv, options) =>
    Effect.gen(function* () {
      calls.push(argv);
      environments.push(options.env);
      const operation = argv[3];

      return {
        exitCode: 0,
        stderr: "",
        stdout:
          operation === "container"
            ? dockerState(config, saved, false)
            : operation === "logs"
              ? JSON.stringify(succeeded)
              : "",
      };
    });

  expect(await run(dockerBackend(config, runner).start(saved, input))).toEqual(succeeded);
  expect(new Set(calls.map((argv) => argv.slice(0, 3).join(" ")))).toEqual(
    new Set(["docker --context colima-loopy-cloud-phase1"]),
  );

  for (const environment of environments) {
    expect(environment).not.toHaveProperty("LOOPY_SANDBOX_TOKEN");
  }

  const create = calls.find((args) => args[3] === "create" && args.includes(saved.container));
  expect(create).toBeDefined();
  expect(create).toContain("--read-only");
  expect(create).toContain("none");
  expect(create).toContain("1000:1000");
  expect(create).toContain("ALL");
  expect(create).toContain("no-new-privileges:true");
  expect(create).toContain(`type=volume,source=${saved.volume},target=/workspace`);
  expect(create).toContain(`type=volume,source=${saved.inputVolume},target=/input,readonly`);
  expect(create).not.toContain("--privileged");
  expect(JSON.stringify(calls)).not.toContain("type=bind");
  expect(JSON.stringify(calls)).not.toContain("docker.sock");
  expect(calls.some((args) => args[3] === "cp")).toBe(true);
});

test("Docker timeout kills only the owned worker and missing or killed workers stay uncertain", async () => {
  const { config, saved } = await capturedReceipt();

  for (const scenario of ["timeout", "missing", "killed", "wrong-owner"] as const) {
    const calls: string[][] = [];
    let running = scenario === "timeout";

    const runner: CommandRunner = (argv) =>
      Effect.gen(function* () {
        calls.push(argv);
        const op = argv[3];

        if (op === "kill") {
          running = false;
        }

        if (op === "wait") {
          return yield* Effect.fail(
            new CommandExecutionError({
              reason: "timeout",
              message: "Process timed out.",
              output: { stdout: "", stderr: "", exitCode: -1 },
              cause: undefined,
            }),
          );
        }

        if (op === "container" && argv[4] === "inspect") {
          if (scenario === "missing") {
            return { stdout: "", stderr: "", exitCode: 1 };
          }

          return {
            stdout: dockerState(
              config,
              scenario === "wrong-owner" ? { ...saved, requestHash: "f".repeat(64) } : saved,
              running,
              scenario === "killed" ? 137 : 0,
            ),
            stderr: "",
            exitCode: 0,
          };
        }

        return { stdout: "", stderr: "", exitCode: 0 };
      });

    const backend = dockerBackend(config, runner);

    if (scenario === "wrong-owner") {
      await expect(run(backend.recover(saved))).rejects.toThrow("ownership does not match");
    } else {
      const result = await run(backend.recover(saved));
      expect(result.kind === "failed" && result.error.code).toBe(
        scenario === "timeout" ? "execution" : "uncertain",
      );
    }

    expect(calls.some((args) => args[3] === "create" || args[3] === "start")).toBe(false);
    expect(calls.some((args) => args[3] === "kill")).toBe(scenario === "timeout");
  }
});

test("lost Docker start acknowledgement and wait transport failure retain started receipts through restart", async () => {
  for (const lostStart of [false, true]) {
    const config = await fixture();
    const fault = Promise.withResolvers<void>();
    let saved: DockerAttemptPlan | null = null;
    let running = false;
    let outage = false;
    let starts = 0;
    let kills = 0;

    const runner: CommandRunner = (argv) =>
      Effect.gen(function* () {
        const op = argv[3];
        let stdout = "";
        let exitCode = 0;

        if (op === "start") {
          starts += 1;
          running = true;

          if (lostStart) {
            exitCode = 1;
          }
        }

        if (op === "container" && argv[4] === "inspect") {
          if (saved === null || outage) {
            exitCode = 1;
          } else {
            stdout = dockerState(config, saved, running, running ? 0 : 137);
          }
        }

        if (op === "container" && argv[4] === "ls" && outage) {
          exitCode = 1;
        }

        if (op === "wait") {
          outage = true;
          fault.resolve();
          exitCode = 1;
        }

        if (op === "kill") {
          kills += 1;
          running = false;
        }

        return { stdout, stderr: "", exitCode };
      });

    const backend: AttemptBackend = {
      start: (plan, input, signal) =>
        Effect.gen(function* () {
          saved = plan;

          return yield* dockerBackend(config, runner).start(plan, input, signal);
        }),
      recover: (plan, signal) => dockerBackend(config, runner).recover(plan, signal),
    };

    const first = await open(config, backend);
    const input = request();
    await run(first.start(input));
    await fault.promise;
    expect(await run(first.lookup(input))).toEqual({ kind: "started" });
    expect(running).toBe(true);
    await run(first.close());
    services.splice(services.indexOf(first), 1);
    const persisted = (await diskReceipts(config.stateRoot))[0];
    expect(persisted?.kind).toBe("started");

    if (!persisted) {
      throw new Error("Expected saved attempt identity.");
    }

    const deadline = persisted.plan.deadline;

    // The restarted service and the monitor it forks read the test clock, which starts at the deadline.
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(deadline);
          const restored = yield* Attempts.open(config, dependencies(config, backend));
          expect(yield* restored.lookup(input)).toEqual({ kind: "started" });
          outage = false;
          // Wakes the recovery retry that the outage put to sleep.
          yield* TestClock.adjust(5000);
          yield* restored.drain();
          const terminal = yield* restored.lookup(input);
          expect(
            terminal.kind === "finished" &&
              terminal.result.kind === "failed" &&
              terminal.result.error.message,
          ).toContain("owned container was killed");
          expect(starts).toBe(1);
          expect(kills).toBe(1);
          expect(running).toBe(false);
          expect(yield* restored.start(input)).toEqual(terminal);
          yield* restored.close();
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  }
});
