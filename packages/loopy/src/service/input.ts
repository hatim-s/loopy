import { Effect } from "effect";
import type { Json, SavedLoopy } from "../contract";
import { validateGraphInput } from "../core";
import { ServiceError } from "./error";

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
