import { archive as runtime } from "../../shell/archive";
import { defineCommand } from "./command";

export const archive = {
  tar: defineCommand(runtime.tar.descriptor),
  gzip: defineCommand(runtime.gzip.descriptor),
  zip: defineCommand(runtime.zip.descriptor),
  unzip: defineCommand(runtime.unzip.descriptor),
};
