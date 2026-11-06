import { Effect } from "effect";
import { OwnershipError, StorageError } from "../core";

// These markers are internal. They never cross the Store contract or wire boundary.
export class StoreInvariantError extends Error {}

export class StoreRejectedError extends Error {}

export class StoredDataError extends Error {}

const classify = (operation: string, cause: unknown): Effect.Effect<never, StorageError> => {
  if (cause instanceof StoreInvariantError) {
    return Effect.die(cause);
  }

  return Effect.fail(
    new StorageError({
      operation,
      reason:
        cause instanceof StoreRejectedError
          ? "rejected"
          : cause instanceof StoredDataError
            ? "corrupt"
            : "unavailable",
      cause,
    }),
  );
};

// The callback includes the complete synchronous transaction and publication.
export function storageOperation<A>(operation: string, body: () => A) {
  return Effect.try({ try: body, catch: (cause) => cause }).pipe(
    Effect.catch(
      (cause): Effect.Effect<never, StorageError> =>
        cause instanceof OwnershipError ? Effect.die(cause) : classify(operation, cause),
    ),
  );
}

export function ownedStorageOperation<A>(operation: string, body: () => A) {
  return Effect.try({ try: body, catch: (cause) => cause }).pipe(
    Effect.catch(
      (cause): Effect.Effect<never, StorageError | OwnershipError> =>
        cause instanceof OwnershipError ? Effect.fail(cause) : classify(operation, cause),
    ),
  );
}
