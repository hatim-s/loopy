import { DEFAULT_PORT, startServer } from "../../local/index.js";
import { type CliContext, expectNoArguments } from "../context.js";
import { printLine } from "../output.js";
import { onTermination } from "../signals.js";

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535.");
  }
  return port;
}

export async function runUi(context: CliContext): Promise<void> {
  expectNoArguments(context);
  const { home, cwd, values } = context;
  const server = startServer({ home, cwd, port: parsePort(values.port) });
  printLine(server.url);
  // Both signals may arrive; stop() aborts running jobs and is safe to await twice.
  onTermination(() => void server.stop());
}
