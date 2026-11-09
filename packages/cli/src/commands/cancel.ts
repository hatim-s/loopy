import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand, RUN_ID } from "../command";
import { printJson } from "../output";

export const cancel = defineCommand({
  path: ["cancel"],
  summary: "Cancel a claimable run",
  options: {},
  positionals: [RUN_ID],
  run: (cli) =>
    Effect.gen(function* () {
      const [id] = cli.args;
      printJson(yield* request(cli, routes.cancelRun, { params: { id } }));
    }),
});
