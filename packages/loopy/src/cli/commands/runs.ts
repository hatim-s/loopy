import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, optionalTarget } from "../context.js";
import { printJson } from "../output.js";

export function runRuns(context: CliContext) {
  return Effect.gen(function* () {
    const slug = yield* optionalTarget(context);
    printJson(
      yield* request(
        context,
        `/runs${slug === undefined ? "" : `?slug=${encodeURIComponent(slug)}`}`,
        routes.runs.response,
      ),
    );
  });
}
