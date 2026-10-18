import { type Store, StoreError, toError } from "../core/index.js";

export async function withHeartbeat<T>(
  store: Store,
  runId: string,
  token: string,
  fn: () => Promise<T>,
): Promise<T> {
  let pending = Promise.resolve();
  let failure: Error | undefined;

  const timer = setInterval(
    () => {
      pending = pending
        .then(async () => {
          if (!(await store.heartbeat(runId, token))) {
            throw new StoreError("owned_elsewhere");
          }
        })
        .catch((cause) => {
          failure = toError(cause);
        });
    },
    Math.max(250, store.leaseMs / 4),
  );

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
