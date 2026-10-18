import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireHead } from "../context.js";
import { jsonInput } from "../input.js";
import { printJson } from "../output.js";

export async function runSchedule(context: CliContext): Promise<void> {
  const { head: slug, rest } = requireHead(context, "Slug");
  const [action = "set", ...extra] = rest;

  if (extra.length || !["set", "enable", "disable", "off"].includes(action)) {
    throw new Error("Use schedule <slug> [set|enable|disable|off].");
  }

  const { cron, tz } = context.values;

  if (
    action !== "set" &&
    (cron !== undefined || tz !== undefined || context.values["input-json"] !== undefined)
  ) {
    throw new Error("Only schedule set accepts cron, timezone and input.");
  }

  const path = `/loopies/${encodeURIComponent(slug)}/schedule`;

  const workspace = `?workspace=${encodeURIComponent(context.cwd)}`;

  if (action === "off") {
    printJson(
      await request(context, `${path}${workspace}`, routes.deleteSchedule.response, {
        method: "DELETE",
      }),
    );

    return;
  }

  if (action === "enable" || action === "disable") {
    printJson(
      await request(context, `${path}/enabled${workspace}`, routes.setScheduleEnabled.response, {
        method: "POST",
        body: { enabled: action === "enable" },
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
