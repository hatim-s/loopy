import { localDaemon } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { report } from "../output.js";
import { onTermination } from "../signals.js";
import { withRunStore } from "../store.js";

export async function runDaemon(context: CliContext): Promise<void> {
  if (requireTarget(context, "Daemon action") !== "run") {
    throw new Error("Unknown daemon action. Use loopy daemon run.");
  }

  await withRunStore(context, async (store) => {
    const daemon = localDaemon({
      ...context,
      store,
      concurrency:
        context.values.concurrency === undefined ? undefined : Number(context.values.concurrency),
      onError: (error, run) => report(run ? `Run ${run.id}: ${error.message}` : error.message),
    });

    const stop = () => {
      void daemon.stop();
    };

    const cleanup = onTermination(stop);

    try {
      await daemon.run();
    } finally {
      cleanup();
      await daemon.stop();
    }
  });
}
