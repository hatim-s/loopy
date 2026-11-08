import { compile } from "@loopy/compiler";
import { Effect } from "effect";

/** Compiles an author file a test wrote, failing the test with the diagnostics when it is invalid. */
export async function compileOrThrow(file: string) {
  const result = await Effect.runPromise(compile(file));

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  return result;
}
