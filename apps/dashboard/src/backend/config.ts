import { z } from "zod";

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

export const backendConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("http"),
    baseUrl: z.string().transform(httpBaseUrl).optional(),
    workspace: z.undefined().optional(),
  }),
  z.strictObject({ mode: z.literal("fake"), workspace: z.undefined().optional() }),
]);
