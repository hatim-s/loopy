import type { Json } from "../../core/index.js";
import { assertJson } from "../../runtime/index.js";
import { type CliContext, requireHead, requireTarget } from "../context.js";
import { printLine } from "../output.js";
import { requireRun, withRunStore } from "../store.js";

export async function runHook(context: CliContext): Promise<void> {
  const { head: runId, rest } = requireHead(context, "Run ID");
  const name = requireTarget({ ...context, positionals: rest }, "Hook name");
  const payload = parsePayload(context.values.payload);

  await withRunStore(context, async (store) => {
    await requireRun(store, runId);

    const waiting = new Set(
      (await store.getSteps(runId))
        .filter((step) => step.status === "waiting")
        .map((step) => step.seq),
    );

    const hook = (await store.listHooks(runId))
      .reverse()
      .find((hook) => hook.name === name && hook.resolvedAt === undefined && waiting.has(hook.seq));

    if (!hook || !(await store.resolveHook(hook.token, payload))) {
      throw new Error(
        `Hook '${name}' is not waiting in run '${runId}'. Run loopy inspect ${runId} to find waiting hooks.`,
      );
    }

    printLine(`Resolved hook '${name}' for run ${runId}. Run loopy resume ${runId} to continue.`);
  });
}

function parsePayload(text = "null"): Json {
  try {
    const payload: unknown = JSON.parse(text);
    assertJson(payload, "Hook payload");

    return payload;
  } catch {
    throw new Error("Hook payload is invalid. Pass valid JSON with --payload.");
  }
}
