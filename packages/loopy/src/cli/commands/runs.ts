import { Effect } from "effect";
import { routes } from "../../contract";
import { request } from "../client";
import { type CliContext, optionalTarget } from "../context";
import { printJson } from "../output";

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
