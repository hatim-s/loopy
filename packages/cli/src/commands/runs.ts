import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { printJson } from "../output";

export const runs = defineCommand({
  path: ["runs"],
  summary: "List runs as JSON",
  options: {},
  positionals: [{ name: "slug", label: "Slug", arity: "optional" }],
  run: (cli) =>
    Effect.gen(function* () {
      const [slug] = cli.args;
      printJson(yield* request(cli, routes.runs, { query: { slug } }));
    }),
});
