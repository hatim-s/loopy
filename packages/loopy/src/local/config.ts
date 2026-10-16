import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireRecord } from "../core/index.js";
import { parseRateLimits, type RateLimits } from "../runtime/index.js";
import { errnoCode } from "./fs.js";

export function readRateLimits(home: string): RateLimits {
  const path = join(home, "config.json");
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
      return {};
    }

    throw cause;
  }

  const config = parseConfig(text, path);

  return parseRateLimits(config.rateLimits ?? {});
}

function parseConfig(text: string, path: string) {
  try {
    return requireRecord(JSON.parse(text), path);
  } catch {
    throw new Error(`Invalid config file '${path}'. Fix or delete it.`);
  }
}
