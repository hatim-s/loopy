import { currentBuilder } from "../builder.js";
import type { AuthorValue, NodeResult } from "../ref.js";

export function subgraph<A extends AuthorValue[], R extends NodeResult>(
  label: string,
  callback: (...args: A) => R,
) {
  return (...args: A): R => {
    return currentBuilder().expand(label, () => callback(...args));
  };
}
