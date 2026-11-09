import { DEFAULT_MAX_OUTPUT_BYTES } from "@loopy/core";
import { Effect, Option } from "effect";
import type { ResolvedCommand } from "../../src/os";
import { executeLocalCommand, type LocalExecutionOptions } from "../../src/os/process";
import { sandboxTool } from "../../src/os/sandbox/tool";
import { qualityTestRoot } from "./quality-test-root";

// Sandboxed bun children read ancestor tsconfig.json files, so stay outside the checkout.
export const workspace = () => qualityTestRoot("process", { outsideCheckout: true });

// The production resolver decides, so a skipped sandbox case matches what commands would get.
const tool = await Effect.runPromise(Effect.option(sandboxTool()));

export const hasBubblewrap = Option.isSome(tool) && tool.value.kind === "linux";

export const canSandbox = Option.isSome(tool);

type CommandFields = Pick<ResolvedCommand, "program" | "args"> & Partial<ResolvedCommand>;

/** Production always runs commands sandboxed with a protected home and declared secrets. */
export function run(
  fields: CommandFields,
  options: Pick<LocalExecutionOptions, "workspace" | "mode"> & Partial<LocalExecutionOptions>,
) {
  return executeLocalCommand(
    {
      cwd: null,
      env: {},
      stdin: null,
      timeoutMs: 300_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      ...fields,
    },
    { protectedHome: workspace(), sensitiveEnv: {}, ...options },
  );
}
