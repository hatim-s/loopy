import { Effect } from "effect";
import { routes } from "../../contract";
import { request } from "../client";
import { type CliContext, requireTarget } from "../context";
import { printJson } from "../output";

export function runResume(context: CliContext) {
  return Effect.gen(function* () {
    const id = yield* requireTarget(context, "Run ID");
    printJson(
      yield* request(context, `/runs/${encodeURIComponent(id)}/resume`, routes.resumeRun.response, {
        method: "POST",
      }),
    );
  });
}
