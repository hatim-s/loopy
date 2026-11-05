import { Effect } from "effect";
import { routes } from "../../contract/index.js";
import { request } from "../client.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printJson } from "../output.js";

export function runList(context: CliContext) {
  return Effect.gen(function* () {
    yield* expectNoArguments(context);
    printJson(
      yield* request(
        context,
        `/loopies?workspace=${encodeURIComponent(context.cwd)}`,
        routes.loopies.response,
      ),
    );
  });
}
