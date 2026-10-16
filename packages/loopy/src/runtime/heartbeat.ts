import { errorMessage } from "../core/index.js";
import { OwnershipError, type RunStore } from "./store.js";

export async function withHeartbeat<T>(
  store: RunStore,
  runId: string,
  token: string,
  fn: () => Promise<T>,
): Promise<T> {
  let pending = Promise.resolve();
  let failure: Error | undefined;

  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        if (!(await store.heartbeat(runId, token))) {
          throw new OwnershipError(runId);
        }
      })
      .catch((cause) => {
        failure = cause instanceof Error ? cause : new Error(errorMessage(cause));
      });
  }, 15_000);

  try {
    const result = await fn();
    await pending;

    if (failure) {
      throw failure;
    }

    return result;
  } finally {
    clearInterval(timer);
    await pending;
  }
}
