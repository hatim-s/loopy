import { OwnershipError } from "../../runtime/index.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";
import { requireRun, withRunStore } from "../store.js";

export async function runCancel(context: CliContext): Promise<void> {
  const id = requireTarget(context, "Run ID");
  await withRunStore(context.home, async (store) => {
    await requireRun(store, id);
    const token = crypto.randomUUID();

    try {
      await store.claim(id, token);
    } catch (error) {
      if (error instanceof OwnershipError) {
        const run = await requireRun(store, id);
        throw new Error(
          `Run '${id}' is owned by PID ${run.owner?.pid} on ${run.owner?.host}. Stop its runner before cancelling.`,
        );
      }

      throw error;
    }

    try {
      await store.finishRun(id, token, { status: "cancelled" });
    } finally {
      await store.release(id, token);
    }

    printJson(await store.getRun(id));
  });
}
