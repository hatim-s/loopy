import type { CommandOutput, ExecuteCommand, RunRecord, SecretBindings } from "../core/index.js";
import { errorMessage, validateSecretBindings } from "../core/index.js";
import { CommandExecutionError } from "../runtime/index.js";
import { executeLocalCommand } from "./process.js";
import { Registry } from "./registry/registry.js";
import { secretRedactor } from "./secret-redactor.js";
import { SecretStore } from "./secrets.js";
import { emptyOutput } from "./spawn.js";
import type { SqliteRunStore } from "./store.js";

/** Looks up each granted value, refusing when the saved grants no longer match the run's. */
function resolveSecretEnv(
  home: string,
  run: RunRecord,
  bindings: SecretBindings,
): Record<string, string> {
  validateSecretBindings(bindings);

  if (run.options.workspace.kind !== "local") {
    throw new Error("Secret bindings require a local workspace.");
  }

  const active = new Registry(home, run.options.workspace.path).get(run.slug).secretBindings;

  if (!active || active.ownerId !== bindings.ownerId) {
    throw new Error(
      `Secret grants for '${run.slug}' were revoked or its source changed. Bind secrets and start a new run.`,
    );
  }

  const values = new SecretStore(home).snapshot();

  return Object.fromEntries(
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

    if (!run || !bindings || !Object.keys(bindings.env).length) {
      return (executor ?? executeLocalCommand)(command, options);
    }

    let env: Record<string, string>;

    try {
      env = resolveSecretEnv(home, run, bindings);
    } catch (error) {
      throw new CommandExecutionError(errorMessage(error), emptyOutput(), false);
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
