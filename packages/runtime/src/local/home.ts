import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultHome(): string {
  return resolve(process.env.LOOPY_HOME ?? join(homedir(), ".loopy"));
}
