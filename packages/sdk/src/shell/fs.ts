import { namespace } from "./builtin";
import { files } from "./fs/files";
import { metadata } from "./fs/metadata";

export const fs = namespace("fs", {
  ...files,
  ...metadata,
});
