import { currentBuilder } from "../builder";
import type { AuthorValue } from "../ref";
import { validateLabel } from "../validate";

export function subgraph<A extends AuthorValue[], R extends AuthorValue>(
  label: string,
  callback: (...args: A) => R,
) {
  validateLabel(label);

  return (...args: A): R => {
    return currentBuilder().expand(label, () => callback(...args));
  };
}
