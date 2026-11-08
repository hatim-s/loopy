import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand } from "../command";
import { CliError } from "../errors";
import { jsonInput } from "../input";
import { printJson } from "../output";
import { INPUT_JSON } from "./run";

export const schedule = defineCommand({
  path: ["schedule"],
  summary: "Set, toggle or remove a loopy's schedule",
  options: {
    cron: { type: "string", value: "expr", description: "Cron expression for the schedule." },
    tz: { type: "string", value: "zone", description: "IANA time zone for the cron expression." },
    "input-json": INPUT_JSON,
    enable: { type: "boolean", description: "Enable the saved schedule." },
    disable: { type: "boolean", description: "Disable the saved schedule." },
    off: { type: "boolean", description: "Remove the schedule." },
  },
  positionals: [{ name: "slug", label: "Slug" }],
  run: (cli) =>
    Effect.gen(function* () {
      const [slug] = cli.args;
      const { off, enable, disable, cron, tz } = cli.values;
      const actions = Number(off) + Number(enable) + Number(disable);

      if (
        actions > 1 ||
        (actions > 0 &&
          (cron !== undefined || tz !== undefined || cli.values["input-json"] !== undefined))
      ) {
        return yield* new CliError({
          message: "Choose one schedule action: --cron, --off, --enable, or --disable.",
        });
      }

      const target = { params: { slug }, query: { workspace: cli.cwd } };

      if (off) {
        printJson(yield* request(cli, routes.deleteSchedule, target));

        return;
      }

      if (enable || disable) {
        printJson(
          yield* request(cli, routes.setScheduleEnabled, { ...target, body: { enabled: enable } }),
        );

        return;
      }

      printJson(
        yield* request(cli, routes.putSchedule, {
          ...target,
          body: { cron, tz, input: yield* jsonInput(cli) },
        }),
      );
    }),
});
