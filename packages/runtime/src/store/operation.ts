import { OwnershipError, StorageError } from "@loopy/core";
import { Effect } from "effect";

export class StoreInvariantError extends Error {
  override readonly name = "StoreInvariantError";
}

export class StoreRejectedError extends Error {}

export class StoredDataError extends Error {}

// An invariant breach is a defect; ownership loss is a defect unless the caller fences on it.
const storeFailure = (operation: string) => (cause: unknown) => {
  if (cause instanceof OwnershipError || cause instanceof StoreInvariantError) {
    return cause;
  }

  return new StorageError({
    operation,
    reason:
      cause instanceof StoreRejectedError
        ? "rejected"
        : cause instanceof StoredDataError
          ? "corrupt"
          : "unavailable",
    cause,
  });
};

export function storageOperation<A>(operation: string, body: () => A) {
  return Effect.try({ try: body, catch: storeFailure(operation) }).pipe(
    Effect.catch(
      (failure): Effect.Effect<never, StorageError> =>
        failure instanceof StorageError ? Effect.fail(failure) : Effect.die(failure),
    ),
  );
}

export function ownedStorageOperation<A>(operation: string, body: () => A) {
  return Effect.try({ try: body, catch: storeFailure(operation) }).pipe(
    Effect.catch(
      (failure): Effect.Effect<never, StorageError | OwnershipError> =>
        failure instanceof StoreInvariantError ? Effect.die(failure) : Effect.fail(failure),
    ),
  );
}
