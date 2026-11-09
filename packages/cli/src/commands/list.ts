import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { printJson } from "../output";

export const list = defineCommand({
  path: ["list"],
  summary: "List saved loopies",
  options: {},
  positionals: [],
  run: (cli) =>
    Effect.gen(function* () {
      printJson(
        yield* request(
          cli,
          `/loopies?workspace=${encodeURIComponent(cli.cwd)}`,
          routes.loopies.response,
        ),
      );
    }),
});
