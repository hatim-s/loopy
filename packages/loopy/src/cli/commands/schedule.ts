import { type CliContext, requireTarget } from "../context.js";
import { jsonInput } from "../input.js";
import { printJson } from "../output.js";
import { runService, withRunStore } from "../store.js";

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

  await withRunStore(context, async (store) => {
    const service = runService(context, store);

    if (off) {
      printJson(await service.deleteSchedule(slug));

      return;
    }

    if (enable || disable) {
      printJson(await service.setScheduleEnabled(slug, !!enable));

      return;
    }

    printJson(await service.putSchedule(slug, { cron, tz, input: await jsonInput(context) }));
  });
}
