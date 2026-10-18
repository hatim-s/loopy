import { routes } from "../../contract/index.js";
import { validateSecretName } from "../../core/index.js";
import { validateSecretValue } from "../../local/index.js";
import { request } from "../client.js";
import { type CliContext, optionalTarget, requireHead } from "../context.js";
import { printJson } from "../output.js";
import { readSecret } from "../secret-entry.js";

async function storeSecret(context: CliContext, name: string | undefined) {
  if (!name) {
    throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
  }

  validateSecretName(name);
  const value = await readSecret(context.values.stdin ?? false);
  validateSecretValue(value);
  printJson(
    await request(context, `/secrets/${encodeURIComponent(name)}`, routes.putSecret.response, {
      method: "PUT",
      body: { value },
    }),
  );
}

export async function runSecrets(context: CliContext): Promise<void> {
  const { head: action, rest } = requireHead(context, "Secret action");
  const name = optionalTarget({ ...context, positionals: rest });

  if (context.values.stdin && action !== "set") {
    throw new Error("--stdin is only supported by loopy secrets set.");
  }

  switch (action) {
    case "list":
      if (name) {
        throw new Error("loopy secrets list takes no name.");
      }

      printJson(await request(context, "/secrets", routes.secrets.response));

      return;
    case "set":
      await storeSecret(context, name);

      return;
    case "remove":
      if (!name) {
        throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
      }

      printJson(
        await request(
          context,
          `/secrets/${encodeURIComponent(name)}`,
          routes.deleteSecret.response,
          { method: "DELETE" },
        ),
      );

      return;
    default:
      throw new Error("Use loopy secrets set <name>, list, or remove <name>.");
  }
}
