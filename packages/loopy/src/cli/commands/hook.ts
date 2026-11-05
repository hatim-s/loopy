import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { assertJson } from "../../core/index.js";
import { request } from "../client.js";
import { type CliContext, requireHead, requireTarget } from "../context.js";
import { CliError } from "../errors.js";
import { printLine } from "../output.js";

export function runHook(context: CliContext) {
  return Effect.gen(function* () {
    const { head: runId, rest } = yield* requireHead(context, "Run ID");
    const name = yield* requireTarget({ ...context, positionals: rest }, "Hook name");
    const payload = yield* parsePayload(context.values.payload);
    yield* request(
      context,
      `/runs/${encodeURIComponent(runId)}/hooks/${encodeURIComponent(name)}`,
      routes.resolveNamedHook.response,
      { method: "POST", body: { payload } },
    );
    printLine(`Resolved hook '${name}' for run ${runId}. The run is ready to continue.`);
  });
}

const parsePayload = (text = "null") =>
  Effect.try({
    try: () => {
      const payload: unknown = JSON.parse(text);
      assertJson(payload, "Hook payload");

      return payload;
    },
    catch: (cause) =>
      new CliError({ message: "Hook payload is invalid. Pass valid JSON with --payload.", cause }),
  });
