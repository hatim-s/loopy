import { files } from "./fs/files.js";
import { metadata } from "./fs/metadata.js";

export const fs = {
  ...files,
  ...metadata,
};
