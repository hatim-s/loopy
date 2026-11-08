import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeBoundary,
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionSpec,
  sandboxExecutionSpecSchema,
} from "@loopy/contract";
import { CommandExecutionError, durationMs, type Json } from "@loopy/core";
import { bundleResult } from "@loopy/runtime/executor/protocol";
import { renderCommand } from "@loopy/runtime/local/execution-host";
import { Effect } from "effect";
import { bundleFile, CONTAINER, containerEnvironment } from "./container-layout";
import { io } from "./operations";
import { runCommand } from "./process";
import { boundedResult, failed } from "./result";

const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  ...containerEnvironment,
};

function bundle(hash: string, input: Json, timeoutMs: number) {
  return Effect.gen(function* () {
    const raw = yield* runCommand(["bun", `${CONTAINER.input}/${bundleFile(hash)}`], {
      stdin: JSON.stringify(input),
      cwd: CONTAINER.workspace,
      env: environment,
      timeoutMs,
      maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
    });

    return bundleResult(raw, (text) => text);
  });
}

function command(spec: Extract<SandboxExecutionSpec, { kind: "command" }>) {
  return Effect.gen(function* () {
    const cwd = yield* io("worker cwd", () =>
      realpath(resolve(CONTAINER.workspace, spec.cwd ?? ".")),
    );

    if (cwd !== CONTAINER.workspace && !cwd.startsWith(`${CONTAINER.workspace}/`)) {
      return failed("validation", "Command cwd must resolve inside /workspace.");
    }

    const raw = yield* runCommand(renderCommand(spec), {
      cwd,
      env: { ...environment, ...spec.env },
      stdin: spec.stdin ?? undefined,
      timeoutMs:
        spec.node.options.timeout === undefined ? 300_000 : durationMs(spec.node.options.timeout),
      maxBytes: Math.min(
        spec.node.options.maxOutputBytes ?? SANDBOX_MAX_CAPTURE_BYTES,
        SANDBOX_MAX_CAPTURE_BYTES,
      ),
    });

    const result = { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode };

    const logs = [
      { message: "stdout", data: raw.stdout },
      { message: "stderr", data: raw.stderr },
    ];

    if (!spec.node.okExitCodes.includes(raw.exitCode)) {
      return {
        ...failed("exit", `Command exited with code ${raw.exitCode}.`),
        exitCode: raw.exitCode,
        logs,
      };
    }

    if (spec.parse === null) {
      return { kind: "succeeded" as const, output: result, logs };
    }

    const parsed = yield* bundle(
      spec.parse.bundleHash,
      { result, input: spec.parse.input },
      300_000,
    );

    return { ...parsed, logs: [...logs, ...parsed.logs] };
  });
}

function executeSpec(spec: SandboxExecutionSpec) {
  return (
    spec.kind === "code" ? bundle(spec.bundleHash, spec.input, spec.timeoutMs) : command(spec)
  ).pipe(
    Effect.map(boundedResult),
    Effect.catch((cause) =>
      Effect.succeed(
        failed(
          cause instanceof CommandExecutionError && cause.reason === "output_limit"
            ? "output_limit"
            : "execution",
          cause.message,
        ),
      ),
    ),
  );
}

if (import.meta.main) {
  const spec = decodeBoundary(sandboxExecutionSpecSchema)(
    await Bun.file(`${CONTAINER.input}/${CONTAINER.request}`).json(),
  );

  process.stdout.write(JSON.stringify(await Effect.runPromise(executeSpec(spec))));
}
