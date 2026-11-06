import { files } from "./fs/files";
import { metadata } from "./fs/metadata";

export const fs = {
  ...files,
  ...metadata,
};
