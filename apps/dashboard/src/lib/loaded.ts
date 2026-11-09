import type { UseQueryResult } from "@tanstack/react-query";
import type { Loaded } from "./view-models";

export function loaded<T>(query: UseQueryResult<T>): Loaded<T> {
  if (query.isPending) {
    return { state: "loading" };
  }

  if (query.isError) {
    return { state: "error", error: query.error };
  }

  return { state: "ready", data: query.data, fetching: query.isFetching };
}

export function mapLoaded<T, U>(value: Loaded<T>, map: (data: T) => U): Loaded<U> {
  return value.state === "ready" ? { ...value, data: map(value.data) } : value;
}
