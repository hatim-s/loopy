import { MAX_LOG_BYTES, outputBytes } from "./effects.js";
import type { AttemptLog } from "./executor.js";
import { isString } from "./validation.js";

export function limitLogs(logs: AttemptLog[]): AttemptLog[] {
  const bounded: AttemptLog[] = [];
  let bytes = 0;

  for (const log of logs) {
    const remaining = MAX_LOG_BYTES - bytes;

    if (remaining < 64) {
      break;
    }

    if (outputBytes(log) <= remaining) {
      bounded.push(log);
      bytes += outputBytes(log);
      continue;
    }

    const message = log.message.slice(0, Math.min(128, Math.floor(remaining / 8)));
    const raw = isString(log.data) ? log.data : JSON.stringify(log.data);
    let length = Math.floor(remaining / 8);
    let truncated = { message, data: `${raw.slice(0, length)} [truncated]` };

    while (outputBytes(truncated) > remaining && length > 0) {
      length = Math.floor(length / 2);
      truncated = { message, data: `${raw.slice(0, length)} [truncated]` };
    }

    if (outputBytes(truncated) <= remaining) {
      bounded.push(truncated);
    }

    break;
  }

  return bounded;
}
