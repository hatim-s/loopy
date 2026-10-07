import { validateSecretName } from "../../core/index.js";
import {
  Registry,
  type SavedWorkflow,
  SecretStore,
  validateSecretValue,
} from "../../local/index.js";
import type { CliContext } from "../context.js";
import { printJson } from "../output.js";
import { readSecret } from "../secret-entry.js";

type BindingAction = "bind" | "unbind" | "bindings";

const STDIN_ONLY_FOR_SET = "--stdin is only supported by loopy secrets set.";

function isBindingAction(action: string | undefined): action is BindingAction {
  return action === "bind" || action === "unbind" || action === "bindings";
}

function applyBinding(
  context: CliContext,
  action: BindingAction,
  slug: string,
  args: string[],
): SavedWorkflow {
  const registry = new Registry(context.home, context.cwd);
  switch (action) {
    case "bind": {
      const [environment, secret, ...extra] = args;
      if (!environment || !secret || extra.length) {
        throw new Error("Use loopy secrets bind <slug> <ENV_VAR> <secret-name>.");
      }
      // Fails early when the secret does not exist, before the binding is written.
      new SecretStore(context.home).get(secret);
      return registry.bindSecret(slug, environment, secret);
    }
    case "unbind": {
      const [environment, ...extra] = args;
      if (!environment || extra.length) {
        throw new Error("Use loopy secrets unbind <slug> <ENV_VAR>.");
      }
      return registry.unbindSecret(slug, environment);
    }
    case "bindings":
      if (args.length) {
        throw new Error("Use loopy secrets bindings <slug>.");
      }
      return registry.get(slug);
  }
}

async function manageBindings(context: CliContext, action: BindingAction, args: string[]) {
  if (context.values.stdin) {
    throw new Error(STDIN_ONLY_FOR_SET);
  }
  const [slug, ...rest] = args;
  if (!slug) {
    throw new Error("A saved workflow slug is required.");
  }
  const saved = applyBinding(context, action, slug, rest);
  printJson({ slug, bindings: saved.secretBindings?.env ?? {} });
}

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
      throw new Error(
        "Use loopy secrets set <name>, list, remove <name>, bind, unbind, or bindings.",
      );
  }
}

export async function runSecrets(context: CliContext): Promise<void> {
  const [action, ...args] = context.positionals;
  if (isBindingAction(action)) {
    await manageBindings(context, action, args);
    return;
  }
  await manageStore(context, action, args);
}
