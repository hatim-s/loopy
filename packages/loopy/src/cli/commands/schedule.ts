import { Loopies, loadLoopy } from "../../local/index.js";
import { assertJson, nextFire, parseCron } from "../../runtime/index.js";
import { type CliContext, requireArgument, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { printJson } from "../output.js";
import { jsonInput } from "../sdk-input.js";

export async function runSchedule(context: CliContext): Promise<void> {
  const slug = requireTarget(context, "Slug");
  const registry = new Loopies(context.home, context.cwd);
  const saved = registry.get(slug);

  if (context.values.off && context.values.cron) {
    throw new Error("Choose --cron or --off. Provide only one schedule action.");
  }

  await withEngineStore(context.home, async (store) => {
    if (context.values.off) {
      await store.deleteSchedule(slug);
      printJson({ slug, scheduled: false });

      return;
    }

    const cron = requireArgument(context.values.cron, "--cron");
    const tz = context.values.tz ?? "UTC";
    const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
    const input = await loopy.validateInput(await jsonInput(context));
    assertJson(input, "Schedule input");

    const schedule = {
      slug,
      cron,
      tz,
      input,
      enabled: true,
      nextFireAt: nextFire(parseCron(cron), new Date(), tz).toISOString(),
    };

    await store.putSchedule(schedule);
    printJson(schedule);
  });
}
