import { currentBuilder } from "../builder.js";
import type { AuthorValue } from "../ref.js";
import { validateLabel } from "../validate.js";

export function subgraph<A extends AuthorValue[], R extends AuthorValue>(
  label: string,
  callback: (...args: A) => R,
) {
  validateLabel(label);

  return (...args: A): R => {
    return currentBuilder().expand(label, () => callback(...args));
  };
}
