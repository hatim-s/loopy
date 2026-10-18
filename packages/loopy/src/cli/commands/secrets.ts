import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, optionalTarget, requireHead } from "../context.js";
import { printJson } from "../output.js";
import { readHiddenSecret, readPipedSecret } from "../secret-entry.js";

async function storeSecret(context: CliContext, name: string | undefined) {
  if (!name) {
    throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
  }

  const value = await (context.values.stdin ? readPipedSecret() : readHiddenSecret());
  printJson(
    await call(context, routes.putSecret, { params: { name }, query: {}, body: { value } }),
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

      printJson(await call(context, routes.secrets, { params: {}, query: {}, body: undefined }));

      return;
    case "set":
      await storeSecret(context, name);

      return;
    case "remove":
      if (!name) {
        throw new Error("Pass a secret name, e.g. loopy secrets set NPM_TOKEN.");
      }

      printJson(
        await call(context, routes.deleteSecret, { params: { name }, query: {}, body: undefined }),
      );

      return;
    default:
      throw new Error("Use loopy secrets set <name>, list, or remove <name>.");
  }
}
