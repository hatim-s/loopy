import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { cliIO } from "../errors";
import { printJson, report } from "../output";

export const types = defineCommand({
  path: ["types"],
  summary: "Generate a typed command module from a CLI's help output",
  options: {
    out: { type: "string", value: "file.ts", required: true, description: "File to write." },
    name: { type: "string", value: "identifier", description: "Exported identifier." },
  },
  positionals: [
    { name: "cli", label: "CLI executable" },
    { name: "command", label: "Command", arity: "rest" },
  ],
  run: (cli) =>
    Effect.gen(function* () {
      const [binary, path] = cli.args;
      const destination = resolve(cli.cwd, cli.values.out);

      const generated = yield* request(cli, "/types", routes.generateTypes.response, {
        method: "POST",
        body: {
          binary: binary.includes("/") ? resolve(cli.cwd, binary) : binary,
          path,
          name: cli.values.name ?? null,
        },
      });

      yield* cliIO(() => mkdir(dirname(destination), { recursive: true }));
      yield* cliIO(() => writeFile(destination, generated.source));

      for (const warning of generated.warnings) {
        report(warning);
      }

      printJson({ file: destination });
    }),
});
