import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxExecutionResult,
  type SandboxExecutionSpec,
  sandboxExecutionSpecSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { durationMs, type Json } from "../../../packages/loopy/src/core/index.js";
import { bundleResult } from "../../../packages/loopy/src/executor/protocol.js";
import { renderCommand } from "../../../packages/loopy/src/local/execution-host.js";
import { CaptureError, runCommand } from "./process.js";
import { boundedResult, failed } from "./result.js";

const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  HOME: "/workspace",
  TMPDIR: "/tmp",
};

async function bundle(hash: string, input: Json, timeoutMs: number) {
  const raw = await runCommand(["bun", `/input/${hash}.mjs`], {
    stdin: JSON.stringify(input),
    cwd: "/workspace",
    env: environment,
    timeoutMs,
    maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
  });

  return bundleResult(raw, (text) => text);
}

async function command(spec: Extract<SandboxExecutionSpec, { kind: "command" }>) {
  const cwd = await realpath(resolve("/workspace", spec.cwd ?? "."));

  if (cwd !== "/workspace" && !cwd.startsWith("/workspace/")) {
    return failed("validation", "Command cwd must resolve inside /workspace.");
  }

  const raw = await runCommand(renderCommand(spec), {
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

  const parsed = await bundle(spec.parse.bundleHash, { result, input: spec.parse.input }, 300_000);

  return { ...parsed, logs: [...logs, ...parsed.logs] };
}

export async function executeSpec(spec: SandboxExecutionSpec): Promise<SandboxExecutionResult> {
  try {
    return boundedResult(
      spec.kind === "code"
        ? await bundle(spec.bundleHash, spec.input, spec.timeoutMs)
        : await command(spec),
    );
  } catch (cause) {
    if (cause instanceof CaptureError) {
      return failed(cause.reason === "output_limit" ? "output_limit" : "execution", cause.message);
    }

    return failed("execution", cause instanceof Error ? cause.message : "Attempt worker failed.");
  }
}

if (import.meta.main) {
  const spec = sandboxExecutionSpecSchema.parse(await Bun.file("/input/request.json").json());
  process.stdout.write(JSON.stringify(await executeSpec(spec)));
}
