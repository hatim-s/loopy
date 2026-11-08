import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeBoundary,
  type ExecutionSpec,
  executionSpecSchema,
  SANDBOX_MAX_CAPTURE_BYTES,
} from "@loopy/contract";
import { type CommandSpec, type Json, renderCommand } from "@loopy/core";
import { bundleResult, commandResult, stoppedResult } from "@loopy/runtime/executor/protocol";
import { CommandExecutionError } from "@loopy/runtime/os";
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

// Sandbox attempts declare no secrets, so nothing in their output needs masking.
const unredacted = (text: string) => text;

function bundle(hash: string, input: Json, timeoutMs: number) {
  return Effect.gen(function* () {
    const raw = yield* runCommand(["bun", `${CONTAINER.input}/${bundleFile(hash)}`], {
      stdin: JSON.stringify(input),
      cwd: CONTAINER.workspace,
      env: environment,
      timeoutMs,
      maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
    });

    return bundleResult(raw, unredacted);
  });
}

function command(spec: CommandSpec) {
  return Effect.gen(function* () {
    const cwd = yield* io("worker cwd", () =>
      realpath(resolve(CONTAINER.workspace, spec.cwd ?? ".")),
    );

    if (cwd !== CONTAINER.workspace && !cwd.startsWith(`${CONTAINER.workspace}/`)) {
      return failed("validation", "Command cwd must resolve inside /workspace.");
    }

    const raw = yield* runCommand(renderCommand(spec, process.platform), {
      cwd,
      env: { ...environment, ...spec.env },
      stdin: spec.stdin ?? undefined,
      timeoutMs: spec.timeoutMs,
      maxBytes: Math.min(
        spec.maxOutputBytes ?? SANDBOX_MAX_CAPTURE_BYTES,
        SANDBOX_MAX_CAPTURE_BYTES,
      ),
    });

    const step = commandResult(spec, raw, unredacted);

    if (step.kind === "finished") {
      return step.result;
    }

    const parsed = yield* bundle(step.bundleHash, step.input, step.timeoutMs);

    return { ...parsed, logs: [...step.logs, ...parsed.logs] };
  });
}

function executeSpec(spec: ExecutionSpec) {
  return (
    spec.kind === "code" ? bundle(spec.bundleHash, spec.input, spec.timeoutMs) : command(spec)
  ).pipe(
    Effect.map(boundedResult),
    Effect.catch((cause) =>
      Effect.succeed(
        cause instanceof CommandExecutionError
          ? boundedResult(stoppedResult(cause, unredacted))
          : failed("execution", cause.message),
      ),
    ),
  );
}

if (import.meta.main) {
  const spec = decodeBoundary(executionSpecSchema)(
    await Bun.file(`${CONTAINER.input}/${CONTAINER.request}`).json(),
  );

  process.stdout.write(JSON.stringify(await Effect.runPromise(executeSpec(spec))));
}
