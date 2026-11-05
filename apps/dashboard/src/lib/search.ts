import { Effect, Option, Schema } from "effect";

/** Invalid URL fields fall back independently without discarding valid filters. */
export const searchField = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(Schema.catchDecoding<S>(() => Effect.succeed(Option.none()))(schema));
