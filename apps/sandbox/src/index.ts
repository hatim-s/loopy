import { parseArgs } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { sandboxConfigSchema } from "./config";
import { startSandbox } from "./server";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    worktree: { type: "string" },
    "state-root": { type: "string" },
    "docker-context": { type: "string" },
    image: { type: "string", default: "loopy-sandbox:bun-1.4.0" },
    hostname: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4010" },
    "max-timeout-ms": { type: "string", default: "600000" },
    memory: { type: "string", default: "256m" },
    cpus: { type: "string", default: "1" },
    pids: { type: "string", default: "64" },
  },
});

const config = decodeBoundary(sandboxConfigSchema)({
  worktree: values.worktree,
  stateRoot: values["state-root"],
  dockerContext: values["docker-context"],
  image: values.image,
  hostname: values.hostname,
  port: Number(values.port),
  maxTimeoutMs: Number(values["max-timeout-ms"]),
  memory: values.memory,
  cpus: Number(values.cpus),
  pids: Number(values.pids),
  token: process.env.LOOPY_SANDBOX_TOKEN,
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* startSandbox(config);
      process.stderr.write(`Sandbox listening at ${service.server.url}\n`);
      yield* Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void);
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);

        return Effect.sync(() => {
          process.off("SIGTERM", stop);
          process.off("SIGINT", stop);
        });
      });
    }),
  ),
);
