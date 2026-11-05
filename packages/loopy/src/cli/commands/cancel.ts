import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, requireTarget } from "../context.js";
import { printJson } from "../output.js";

export function runCancel(context: CliContext) {
  return Effect.gen(function* () {
    const id = yield* requireTarget(context, "Run ID");
    printJson(
      yield* request(context, `/runs/${encodeURIComponent(id)}/cancel`, routes.cancelRun.response, {
        method: "POST",
      }),
    );
  });
}
