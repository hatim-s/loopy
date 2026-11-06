import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { routes } from "../../contract";
import { request } from "../client";
import { type CliContext, requireArgument, requireHead } from "../context";
import { cliIO } from "../errors";
import { printJson, report } from "../output";

export function runTypes(context: CliContext) {
  return Effect.gen(function* () {
    const { head: binary, rest: path } = yield* requireHead(context, "CLI executable");
    const destination = resolve(context.cwd, yield* requireArgument(context.values.out, "--out"));

    const generated = yield* request(context, "/types", routes.generateTypes.response, {
      method: "POST",
      body: {
        binary: binary.includes("/") ? resolve(context.cwd, binary) : binary,
        path,
        name: context.values.name ?? null,
      },
    });

    yield* cliIO(() => mkdir(dirname(destination), { recursive: true }));
    yield* cliIO(() => writeFile(destination, generated.source));

    for (const warning of generated.warnings) {
      report(warning);
    }

    printJson({ file: destination });
  });
}
