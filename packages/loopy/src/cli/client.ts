import { resolve } from "node:path";
import type { z } from "zod";
import { DEFAULT_ERROR_MESSAGES, type ErrorCode, errorBodySchema } from "../contract/index.js";
import { readDaemonFile } from "../local/index.js";
import type { CliContext } from "./context.js";

type ClientContext = Pick<CliContext, "home" | "cwd">;

export async function ensureDaemon(context: ClientContext & { port?: number }) {
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
      String(context.port ?? 0),
    ],
    { cwd: context.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );

  for (let attempt = 0; attempt < 100; attempt++) {
    const record = readDaemonFile(context.home);

    if (record) {
      if (record.pid === child.pid) {
        child.unref();
      } else {
        // Keep the losing child referenced until it exits so Bun finishes this request.
        child.kill();
        await child.exited;
      }

      return record;
    }

    await Bun.sleep(50);
  }

  child.kill();
  await child.exited;
  throw new Error("The daemon did not start. Run loopy daemon run to inspect the error.");
}

export class DaemonError extends Error {
  constructor(
    readonly code: ErrorCode,
    message = DEFAULT_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

type Route = {
  method: string;
  path: string;
  params: z.ZodType<Record<string, string>>;
  query: z.ZodObject;
  body: z.ZodType;
  response: z.ZodType;
};

export async function call<R extends Route>(
  context: ClientContext,
  route: R,
  options: {
    params: z.output<R["params"]>;
    query: z.input<R["query"]>;
    body: z.input<R["body"]>;
  },
): Promise<z.output<R["response"]>> {
  const record = await ensureDaemon(context);
  const params = options.params;

  const path = route.path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        return segment;
      }

      const value = params[segment.slice(1)];

      if (value === undefined) {
        throw new Error(`Route ${route.path} needs ${segment}.`);
      }

      return encodeURIComponent(value);
    })
    .join("/");

  const url = new URL(`/api${path}`, `http://127.0.0.1:${record.port}`);

  for (const [key, value] of Object.entries(options.query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: route.method,
    headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const value: unknown = await response.json();

  if (!response.ok) {
    const { error } = errorBodySchema.parse(value);
    throw new DaemonError(error.code, error.message);
  }

  const schema: R["response"] = route.response;

  return schema.parse(value);
}
