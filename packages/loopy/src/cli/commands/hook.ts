import type { Json } from "../../core/index.js";
import { assertJson } from "../../runtime/index.js";
import { type CliContext, requireHead, requireTarget } from "../context.js";
import { printLine } from "../output.js";
import { runService, withRunStore } from "../store.js";

export async function runHook(context: CliContext): Promise<void> {
  const { head: runId, rest } = requireHead(context, "Run ID");
  const name = requireTarget({ ...context, positionals: rest }, "Hook name");
  const payload = parsePayload(context.values.payload);

  await withRunStore(context, async (store) => {
    await runService(context, store).resolveNamedHook(runId, name, payload);
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
