import type { ExecutionMode } from "../core/index.js";
import {
  CommandExecutionError,
  CommandExitError,
  type Executor,
  type ResolvedCommand,
} from "../runtime/index.js";
import { executeLocalCommand, localRunOptions } from "./process.js";
import { secretRedactor } from "./secret-executor.js";
import { SecretStore } from "./secrets.js";

export class LocalExecutor implements Executor {
  private readonly sensitiveEnv: Record<string, string>;

  constructor(home?: string, secrets: readonly string[] = []) {
    const store = new SecretStore(home);
    this.sensitiveEnv = Object.fromEntries(secrets.map((name) => [name, store.get(name)]));
  }

  async execute(
    command: ResolvedCommand,
    options: { cwd: string; mode: ExecutionMode; timeoutMs?: number },
  ) {
    const redact = secretRedactor(Object.values(this.sensitiveEnv));

    try {
      const result = await executeLocalCommand(
        {
          ...command,
          timeoutMs: options.timeoutMs ?? command.timeoutMs,
        },
        { ...localRunOptions(options.cwd, options.mode), sensitiveEnv: this.sensitiveEnv },
      );

      const output = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };

      if (output.exitCode !== 0) {
        throw new CommandExitError(output);
      }

      return output;
    } catch (error) {
      if (error instanceof CommandExitError) {
        throw error;
      }

      if (error instanceof CommandExecutionError) {
        throw new CommandExecutionError(
          redact(error.message),
          {
            ...error.output,
            stdout: redact(error.output.stdout, true),
            stderr: redact(error.output.stderr, true),
          },
          error.started,
        );
      }

      throw error;
    }
  }
}
