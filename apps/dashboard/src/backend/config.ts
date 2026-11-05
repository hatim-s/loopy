import { Schema, SchemaGetter } from "effect";

export function httpBaseUrl(value: string): string {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("API base URL must use HTTP or HTTPS without credentials, query or fragment.");
  }

  return url.href.replace(/\/+$/, "");
}

export const backendConfigSchema = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("http"),
    baseUrl: Schema.optional(
      Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform(httpBaseUrl),
          encode: SchemaGetter.passthrough(),
        }),
      ),
    ),
    workspace: Schema.optional(Schema.Undefined),
  }),
  Schema.Struct({ mode: Schema.Literal("fake"), workspace: Schema.optional(Schema.Undefined) }),
]);
