import { type AttemptRecord } from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type { SandboxAttemptAuthority } from "../../../packages/loopy/src/contract/sandbox-journal-rpc.js";
import { AttemptConflict } from "./admission.js";
import { pause } from "./attempt-monitor.js";

export async function resolveAdmissionRead({
  authority,
  id,
  signal,
  cause,
}: {
  authority: SandboxAttemptAuthority;
  id: string;
  signal: AbortSignal;
  cause: Error;
}) {
  let backoff = 100;

  while (!signal.aborted) {
    let record: AttemptRecord | null;

    try {
      record = await authority.read(id);
    } catch {
      if (!(await pause(backoff, signal))) {
        break;
      }

      backoff = Math.min(backoff * 2, 5000);
      continue;
    }

    if (record === null) {
      throw cause;
    }

    return record;
  }

  throw new AttemptConflict("Sandbox service is stopping.");
}
