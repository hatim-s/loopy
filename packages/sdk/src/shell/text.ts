import { namespace } from "./builtin";
import { filter } from "./text/filter";
import { format } from "./text/format";

export const text = namespace("text", {
  ...filter,
  ...format,
});
