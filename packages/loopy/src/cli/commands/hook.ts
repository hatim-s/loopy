import { routes } from "../../contract/index.js";
import type { Json } from "../../core/index.js";
import { assertJson } from "../../core/index.js";
import { request } from "../client.js";
import { type CliContext, requireHead, requireTarget } from "../context.js";
import { printLine } from "../output.js";

export async function runHook(context: CliContext): Promise<void> {
  const { head: runId, rest } = requireHead(context, "Run ID");
  const name = requireTarget({ ...context, positionals: rest }, "Hook name");
  const payload = parsePayload(context.values.payload);

  await request(
    context,
    `/runs/${encodeURIComponent(runId)}/hooks/${encodeURIComponent(name)}`,
    routes.resolveNamedHook.response,
    { method: "POST", body: { payload } },
  );
  printLine(`Resolved hook '${name}' for run ${runId}. The run is ready to continue.`);
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
