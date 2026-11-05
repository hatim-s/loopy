import { Effect } from "effect";
import type { Json, SavedLoopy } from "../contract/index.js";
import { validateGraphInput } from "../core/index.js";
import { ServiceError } from "./error.js";

export const validateDefinitionInput = Effect.fn("input.validateDefinitionInput")(function* (
  saved: SavedLoopy,
  input: Json,
) {
  const result = validateGraphInput(saved.graph, input);

  if (!result.ok) {
    return yield* Effect.fail(new ServiceError("bad_request", result.error));
  }

  return result.value;
});
