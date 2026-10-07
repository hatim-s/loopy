import { errorMessage } from "../core/errors.js";
import type { CommandOutput, ExecuteCommand } from "../core/model.js";
import { validateSecretBindings } from "../core/secret-bindings.js";
import { CommandExecutionError } from "../runtime/errors.js";
import { executeLocalCommand } from "./process.js";
import { Registry } from "./registry.js";
import { SecretStore } from "./secrets.js";
import type { SqliteRunStore } from "./store.js";

/** Exact values are masked. Truncated output also masks a secret prefix at the stream boundary. */
export function secretRedactor(values: string[]) {
  const secrets = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = secrets.length
    ? new RegExp(
        secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      )
    : undefined;
  return (text: string, truncated = false): string => {
    if (truncated) {
      let boundary = 0;
      for (const secret of secrets) {
        for (let length = Math.min(secret.length, text.length); length > boundary; length--) {
          if (text.endsWith(secret.slice(0, length))) {
            boundary = length;
            break;
          }
        }
      }
      if (boundary) {
        text = `${text.slice(0, -boundary)}[redacted]`;
      }
    }
    return pattern ? text.replace(pattern, "[redacted]") : text;
  };
}

/** Resolve grants only after the runtime has checkpointed the value-free command. */
export function secretExecutor(
  home: string,
  store: SqliteRunStore,
  executor?: ExecuteCommand,
): ExecuteCommand {
  return async (command, options) => {
    const run = await store.getRun(options.runId);
    const bindings = run?.options.secretBindings;
    if (!bindings || !Object.keys(bindings.env).length) {
      return (executor ?? executeLocalCommand)(command, options);
    }
    const empty: CommandOutput = { stdout: "", stderr: "", exitCode: -1, durationMs: 0 };
    let env: Record<string, string>;
    try {
      validateSecretBindings(bindings);
      if (!run || run.options.workspace.kind !== "local") {
        throw new Error("Secret bindings require a local workspace.");
      }
      const active = new Registry(home, run.options.workspace.path).get(run.slug).secretBindings;
      if (!active || active.ownerId !== bindings.ownerId) {
        throw new Error(
          `Secret grants for '${run.slug}' were revoked or its source changed. Bind secrets and start a new run.`,
        );
      }
      const values = new SecretStore(home).snapshot();
      env = Object.fromEntries(
        Object.entries(bindings.env).map(([key, name]) => {
          if (!Object.hasOwn(active.env, key) || active.env[key] !== name) {
            throw new Error(
              `Secret binding '${key}' changed. Start a new run to use the current bindings.`,
            );
          }
          const value =
            (Object.hasOwn(process.env, key) ? process.env[key] : undefined) ??
            (Object.hasOwn(values, name) ? values[name] : undefined);
          if (value === undefined) {
            throw new Error(`No stored secret '${name}'. Use loopy secrets set ${name}.`);
          }
          return [key, value];
        }),
      );
    } catch (error) {
      throw new CommandExecutionError(errorMessage(error), empty, false);
    }
    const redact = secretRedactor(Object.values(env));
    const output = (value: CommandOutput, truncated = false): CommandOutput => ({
      ...value,
      stdout: redact(value.stdout, truncated),
      stderr: redact(value.stderr, truncated),
    });
    try {
      const value = executor
        ? await executor({ ...command, env: { ...command.env, ...env } }, options)
        : await executeLocalCommand(command, { ...options, sensitiveEnv: env });
      return output(value);
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        throw new CommandExecutionError(
          redact(error.message),
          output(error.output, true),
          error.started,
        );
      }
      // Preserve the runtime's uncertainty classification for an unknown executor failure.
      throw new Error(redact(errorMessage(error)));
    }
  };
}
