import { validateSecretName } from "../../core/index.js";
import { SecretStore, validateSecretValue } from "../../local/index.js";
import { type CliContext, optionalTarget, requireHead } from "../context.js";
import { printJson } from "../output.js";
import { readSecret } from "../secret-entry.js";

async function storeSecret(context: CliContext, store: SecretStore, name: string | undefined) {
  if (!name) {
    throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
  }

  validateSecretName(name);
  const value = await readSecret(context.values.stdin ?? false);
  validateSecretValue(value);
  store.set(name, value);
  printJson({ name, saved: true });
}

export async function runSecrets(context: CliContext): Promise<void> {
  const { head: action, rest } = requireHead(context, "Secret action");
  const name = optionalTarget({ ...context, positionals: rest });

  if (context.values.stdin && action !== "set") {
    throw new Error("--stdin is only supported by loopy secrets set.");
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
        throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
      }

      store.remove(name);
      printJson({ name, removed: true });

      return;
    default:
      throw new Error("Use loopy secrets set <name>, list, or remove <name>.");
  }
}
