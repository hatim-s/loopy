import { validateSecretName } from "../../core/index.js";
import { SecretStore, validateSecretValue } from "../../local/index.js";
import type { CliContext } from "../context.js";
import { printJson } from "../output.js";
import { readSecret } from "../secret-entry.js";

const STDIN_ONLY_FOR_SET = "--stdin is only supported by loopy secrets set.";

async function storeSecret(context: CliContext, store: SecretStore, name: string | undefined) {
  if (!name) {
    throw new Error("A secret name is required.");
  }

  validateSecretName(name);
  const value = await readSecret(context.values.stdin ?? false);
  validateSecretValue(value);
  store.set(name, value);
  printJson({ name, saved: true });
}

async function manageStore(context: CliContext, action: string | undefined, args: string[]) {
  const [name, ...rest] = args;

  if (rest.length) {
    throw new Error(
      "Unexpected secret arguments. Values must be entered privately or supplied through --stdin.",
    );
  }

  if (context.values.stdin && action !== "set") {
    throw new Error(STDIN_ONLY_FOR_SET);
  }

  const store = new SecretStore(context.home);

  switch (action) {
    case "list":
      if (name) {
        throw new Error("loopy secrets list takes no name.");
      }

      printJson(store.list());

      return;
    case "set":
      await storeSecret(context, store, name);

      return;
    case "remove":
      if (!name) {
        throw new Error("A secret name is required.");
      }

      store.remove(name);
      printJson({ name, removed: true });

      return;
    default:
      throw new Error("Use loopy secrets set <name>, list, or remove <name>.");
  }
}

export async function runSecrets(context: CliContext): Promise<void> {
  const [action, ...args] = context.positionals;

  await manageStore(context, action, args);
}
