import { Effect } from "effect";
import { routes } from "../../contract";
import { validateSecretName } from "../../core";
import { validateSecretValue } from "../../local";
import { request } from "../client";
import { type CliContext, optionalTarget, requireHead } from "../context";
import { CliError, cliSync } from "../errors";
import { printJson } from "../output";
import { readSecret } from "../secret-entry";

function storeSecret(context: CliContext, name: string | undefined) {
  return Effect.gen(function* () {
    if (!name) {
      return yield* Effect.fail(
        new CliError({ message: "Pass a secret name, e.g. loopy secrets set NPM_TOKEN." }),
      );
    }

    yield* cliSync(() => validateSecretName(name));
    const value = yield* readSecret(context.values.stdin ?? false);
    yield* cliSync(() => validateSecretValue(value));
    printJson(
      yield* request(context, `/secrets/${encodeURIComponent(name)}`, routes.putSecret.response, {
        method: "PUT",
        body: { value },
      }),
    );
  });
}

export function runSecrets(context: CliContext) {
  return Effect.gen(function* () {
    const { head: action, rest } = yield* requireHead(context, "Secret action");
    const name = yield* optionalTarget({ ...context, positionals: rest });

    if (context.values.stdin && action !== "set") {
      return yield* Effect.fail(
        new CliError({ message: "--stdin is only supported by loopy secrets set." }),
      );
    }

    switch (action) {
      case "list":
        if (name) {
          return yield* Effect.fail(new CliError({ message: "loopy secrets list takes no name." }));
        }

        printJson(yield* request(context, "/secrets", routes.secrets.response));

        return;
      case "set":
        yield* storeSecret(context, name);

        return;
      case "remove":
        if (!name) {
          return yield* Effect.fail(
            new CliError({ message: "Pass a secret name, e.g. loopy secrets set NPM_TOKEN." }),
          );
        }

        printJson(
          yield* request(
            context,
            `/secrets/${encodeURIComponent(name)}`,
            routes.deleteSecret.response,
            { method: "DELETE" },
          ),
        );

        return;
      default:
        return yield* Effect.fail(
          new CliError({ message: "Use loopy secrets set <name>, list, or remove <name>." }),
        );
    }
  });
}
