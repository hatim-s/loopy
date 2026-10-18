import { resolve } from "node:path";
import type { z } from "zod";
import { errorBodySchema } from "../contract/index.js";
import { readDaemonFile } from "../local/index.js";
import type { CliContext } from "./context.js";

type ClientContext = Pick<CliContext, "home" | "cwd">;

export async function ensureDaemon(context: ClientContext & { port?: string }) {
  const current = readDaemonFile(context.home);

  if (current) {
    return current;
  }

  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, import.meta.path.endsWith(".ts") ? "index.ts" : "index.js"),
      "--home",
      context.home,
      "--cwd",
      context.cwd,
      "daemon",
      "run",
      "--port",
      context.port ?? "0",
    ],
    { cwd: context.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );

  child.unref();

  for (let attempt = 0; attempt < 100; attempt++) {
    const record = readDaemonFile(context.home);

    if (record) {
      // A concurrent CLI call started the daemon that won; this child lost the startup race.
      if (record.pid !== child.pid) {
        child.kill();
      }

      return record;
    }

    await Bun.sleep(50);
  }

  child.kill();
  throw new Error("The daemon did not start. Run loopy daemon run to inspect the error.");
}

export async function request<T>(
  context: ClientContext,
  path: string,
  schema: z.ZodType<T>,
  options: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: object } = { method: "GET" },
): Promise<T> {
  const record = await ensureDaemon(context);

  const response = await fetch(`http://127.0.0.1:${record.port}/api${path}`, {
    method: options.method,
    headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // BOUNDARY: HTTP data is parsed once through the shared response or error schema.
  const value: unknown = await response.json();

  if (!response.ok) {
    throw new Error(errorBodySchema.parse(value).error.message);
  }

  return schema.parse(value);
}
