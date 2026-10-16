import { localDaemon } from "../../local/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { withEngineStore } from "../engine-store.js";
import { report } from "../output.js";

export async function runDaemon(context: CliContext): Promise<void> {
  if (requireTarget(context, "Daemon action") !== "run") {
    throw new Error("Unknown daemon action. Use loopy daemon run.");
  }

  await withEngineStore(context.home, async (store) => {
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

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await daemon.run();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await daemon.stop();
    }
  });
}
