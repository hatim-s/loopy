import { routes } from "@loopy/contract";
import { validateSecretName } from "@loopy/core";
import { validateSecretValue } from "@loopy/runtime/local";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { cliSync } from "../errors";
import { printJson } from "../output";
import { readSecret } from "../secret-entry";

const SECRET_NAME = { name: "name", label: "Secret name" } as const;

export const secretsSet = defineCommand({
  path: ["secrets", "set"],
  summary: "Store a secret privately",
  options: {
    stdin: { type: "boolean", description: "Read the value from piped stdin instead of a prompt." },
  },
  positionals: [SECRET_NAME],
  run: (cli) =>
    Effect.gen(function* () {
      const [name] = cli.args;
      // Reject a bad name before asking for a hidden value.
      yield* cliSync(() => validateSecretName(name));
      const value = yield* readSecret(cli.values.stdin);
      yield* cliSync(() => validateSecretValue(value));
      printJson(
        yield* request(cli, `/secrets/${encodeURIComponent(name)}`, routes.putSecret.response, {
          method: "PUT",
          body: { value },
        }),
      );
    }),
});

export const secretsList = defineCommand({
  path: ["secrets", "list"],
  summary: "List secret names",
  options: {},
  positionals: [],
  run: (cli) =>
    Effect.gen(function* () {
      printJson(yield* request(cli, "/secrets", routes.secrets.response));
    }),
});

export const secretsRemove = defineCommand({
  path: ["secrets", "remove"],
  summary: "Delete a stored secret",
  options: {},
  positionals: [SECRET_NAME],
  run: (cli) =>
    Effect.gen(function* () {
      const [name] = cli.args;
      printJson(
        yield* request(cli, `/secrets/${encodeURIComponent(name)}`, routes.deleteSecret.response, {
          method: "DELETE",
        }),
      );
    }),
});
