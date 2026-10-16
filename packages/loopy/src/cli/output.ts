// BOUNDARY: The output serializer accepts validated domain records of different shapes.
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Plain stdout text that is not JSON, such as usage or a server URL. */
export function printLine(text: string): void {
  console.log(text);
}

/** Human-facing messages go to stderr so stdout stays parseable. */
export function report(message: string): void {
  console.error(message);
}
