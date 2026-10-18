import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { jsonInput } from "../input.js";
import { printJson } from "../output.js";

export async function runSchedule(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  const { off, enable, disable, cron, tz } = context.values;
  const actions = Number(!!off) + Number(!!enable) + Number(!!disable);

  if (
    actions > 1 ||
    (actions > 0 &&
      (cron !== undefined || tz !== undefined || context.values["input-json"] !== undefined))
  ) {
    throw new Error("Choose one schedule action: --cron, --off, --enable, or --disable.");
  }

  const path = `/loopies/${encodeURIComponent(slug)}/schedule`;

  const workspace = `?workspace=${encodeURIComponent(context.cwd)}`;

  if (off) {
    printJson(
      await request(context, `${path}${workspace}`, routes.deleteSchedule.response, {
        method: "DELETE",
      }),
    );

    return;
  }

  if (enable || disable) {
    printJson(
      await request(context, `${path}/enabled${workspace}`, routes.setScheduleEnabled.response, {
        method: "POST",
        body: { enabled: !!enable },
      }),
    );

    return;
  }

  printJson(
    await request(context, `${path}${workspace}`, routes.putSchedule.response, {
      method: "PUT",
      body: { cron, tz, input: await jsonInput(context) },
    }),
  );
}
