import { routes } from "../../contract/index.js";
import { call } from "../client.js";
import { type CliContext, requireHead } from "../context.js";
import { jsonInput } from "../input.js";
import { printJson } from "../output.js";

export async function runSchedule(context: CliContext): Promise<void> {
  const { head: slug, rest } = requireHead(context, "Slug");

  if (rest.length > 1) {
    throw new Error(`Unexpected arguments: ${rest.slice(1).join(" ")}.`);
  }

  const { action, cron, tz } = context.values;
  const params = { slug };
  const query = { workspace: context.cwd };

  if (action === "off") {
    printJson(await call(context, routes.deleteSchedule, { params, query, body: undefined }));
  } else if (action === "enable" || action === "disable") {
    printJson(
      await call(context, routes.setScheduleEnabled, {
        params,
        query,
        body: { enabled: action === "enable" },
      }),
    );
  } else {
    printJson(
      await call(context, routes.putSchedule, {
        params,
        query,
        body: { cron, tz, input: await jsonInput(context) },
      }),
    );
  }
}
