import { Schema } from "effect";

export const jsonSchema = Schema.MutableJson;

export type Json = Schema.Schema.Type<typeof jsonSchema>;
