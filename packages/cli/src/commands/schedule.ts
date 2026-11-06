import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { CliError } from "../errors";
import { jsonInput } from "../input";
import { printJson } from "../output";

export function runSchedule(context: CliContext) {
  return Effect.gen(function* () {
    const slug = yield* requireTarget(context, "Slug");
    const { off, enable, disable, cron, tz } = context.values;
    const actions = Number(!!off) + Number(!!enable) + Number(!!disable);

    if (
      actions > 1 ||
      (actions > 0 &&
        (cron !== undefined || tz !== undefined || context.values["input-json"] !== undefined))
    ) {
      return yield* Effect.fail(
        new CliError({
          message: "Choose one schedule action: --cron, --off, --enable, or --disable.",
        }),
      );
    }

    const path = `/loopies/${encodeURIComponent(slug)}/schedule`;
    const workspace = `?workspace=${encodeURIComponent(context.cwd)}`;

    if (off) {
      printJson(
        yield* request(context, `${path}${workspace}`, routes.deleteSchedule.response, {
          method: "DELETE",
        }),
      );

      return;
    }

    if (enable || disable) {
      printJson(
        yield* request(context, `${path}/enabled${workspace}`, routes.setScheduleEnabled.response, {
          method: "POST",
          body: { enabled: !!enable },
        }),
      );

      return;
    }

    printJson(
      yield* request(context, `${path}${workspace}`, routes.putSchedule.response, {
        method: "PUT",
        body: { cron, tz, input: yield* jsonInput(context) },
      }),
    );
  });
}
