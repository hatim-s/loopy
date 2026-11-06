import { Effect } from "effect";
import type { ExecutionMode } from "../../core";
import { unstarted } from "../spawn";
import { macSandbox } from "./darwin";
import { linuxSandbox } from "./linux";

export type SandboxOptions = {
  program: string;
  workspace: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  scratch: string;
  helper?: string;
  protectedHome?: string;
  mode: ExecutionMode;
};

export function sandboxLauncher(options: SandboxOptions) {
  return Effect.gen(function* () {
    if (process.platform === "darwin") {
      return yield* macSandbox(options);
    }

    if (process.platform === "linux") {
      return yield* linuxSandbox(options);
    }

    return yield* Effect.fail(
      unstarted(new Error(`Sandbox mode is unavailable on ${process.platform}.`)),
    );
  });
}
