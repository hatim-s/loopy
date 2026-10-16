import { CommandExecutionError, type Executor, type ResolvedCommand } from "../runtime/index.js";
import { executeLocalCommand, localRunOptions } from "./process.js";
import { secretRedactor } from "./secret-executor.js";
import { SecretStore } from "./secrets.js";

export class LocalExecutor implements Executor {
  private readonly sensitiveEnv: Record<string, string>;
  private readonly redact: ReturnType<typeof secretRedactor>;

  constructor({ home, secrets }: { home: string; secrets: readonly string[] }) {
    const store = new SecretStore(home);
    this.sensitiveEnv = Object.fromEntries(secrets.map((name) => [name, store.get(name)]));
    this.redact = secretRedactor(Object.values(this.sensitiveEnv));
  }

  async execute(command: ResolvedCommand, options: Parameters<Executor["execute"]>[1]) {
    const redact = this.redact;

    try {
      const result = await executeLocalCommand(
        {
          ...command,
          timeoutMs: options.timeoutMs,
        },
        {
          ...localRunOptions(options.workspace, options.mode),
          sensitiveEnv: this.sensitiveEnv,
          signal: options.signal,
        },
      );

      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    } catch (error) {
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
