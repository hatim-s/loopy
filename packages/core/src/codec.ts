import { Schema, Struct } from "effect";

// Domain records are built and updated in place by the engine and stores.
export const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));

export const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const hashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
