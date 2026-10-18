import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { SECRET_VALUE_MAX_BYTES } from "../contract/index.js";
import { DaemonError } from "./errors.js";

// A trailing CRLF is stripped after reading, so it does not count against the limit.
const LINE_ENDING_BYTES = 2;

export async function readPipedSecret(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new DaemonError(
      "bad_request",
      "--stdin requires piped input. Omit it to enter a secret privately.",
    );
  }

  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;

    if (bytes > SECRET_VALUE_MAX_BYTES + LINE_ENDING_BYTES) {
      throw new DaemonError("bad_request", "Secret input exceeds 64 KiB.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

export async function readHiddenSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new DaemonError(
      "bad_request",
      "Secret entry requires a terminal. Pipe the value with --stdin for automation.",
    );
  }

  // readline echoes typed characters to its output; a muted sink keeps the value off screen.
  const muted = new Writable({
    write(...[, , done]) {
      done();
    },
  });

  const terminal = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });

  process.stderr.write("Secret value (hidden): ");

  try {
    return await new Promise<string>((resolve, reject) => {
      terminal.once("line", resolve);
      terminal.once("close", () =>
        reject(new DaemonError("bad_request", "Secret entry cancelled.")),
      );
      terminal.once("SIGINT", () => terminal.close());
    });
  } finally {
    terminal.close();
    muted.end();
    process.stderr.write("\n");
  }
}
