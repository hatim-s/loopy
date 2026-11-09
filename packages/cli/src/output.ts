import type { Json } from "@loopy/core";

/** Json plus absent optional keys, which JSON.stringify drops. */
type Printable = Json | readonly Printable[] | { readonly [key: string]: Printable | undefined };

export function printJson(value: Printable): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printLine(text: string): void {
  console.log(text);
}

/** Human-facing messages go to stderr so stdout stays parseable. */
export function report(message: string): void {
  console.error(message);
}
