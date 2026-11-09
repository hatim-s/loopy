import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { CliError } from "../errors";
import { graphInput } from "../input";
import { printJson } from "../output";

export const INPUT_JSON = {
  type: "string",
  value: "json",
  description: "Input as a JSON object.",
} as const;

export const run = defineCommand({
  path: ["run"],
  summary: "Queue a run with named, JSON or file input",
  options: {
    "input-json": INPUT_JSON,
    "input-file": { type: "string", value: "file", description: "Read JSON input from a file." },
  },
  positionals: [{ name: "slug", label: "Slug" }],
  namedInput: true,
  run: (cli) =>
    Effect.gen(function* () {
      const [slug] = cli.args;

      const sources =
        Number(cli.namedInput !== undefined) +
        Number(cli.values["input-json"] !== undefined) +
        Number(cli.values["input-file"] !== undefined);

      if (sources > 1) {
        return yield* new CliError({
          message: "Choose one input source: named flags, --input-json, or --input-file.",
        });
      }

      const { graph } = yield* request(
        cli,
        `/loopies/${encodeURIComponent(slug)}/graph?workspace=${encodeURIComponent(cli.cwd)}`,
        routes.graph.response,
      );

      printJson(
        yield* request(cli, `/loopies/${encodeURIComponent(slug)}/runs`, routes.startRun.response, {
          method: "POST",
          body: { input: yield* graphInput(graph.input, cli), workspace: cli.cwd },
        }),
      );
    }),
});
