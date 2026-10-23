import type { Json, SavedLoopy } from "../contract/index.js";
import { validateGraphInput } from "../core/index.js";
import { ServiceError } from "./error.js";

export function validateDefinitionInput(saved: SavedLoopy, input: Json): Json {
  const result = validateGraphInput(saved.graph, input);

  if (!result.ok) {
    throw new ServiceError("bad_request", result.error);
  }

  return result.value;
}
