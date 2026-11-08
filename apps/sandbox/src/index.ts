import { parseArgs } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { sandboxConfig, sandboxConfigSchema } from "./config";
import { SANDBOX_IMAGE } from "./docker/identity";
import { startSandbox } from "./server";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    worktree: { type: "string" },
    "docker-context": { type: "string" },
    image: { type: "string", default: SANDBOX_IMAGE },
    hostname: { type: "string" },
    port: { type: "string" },
    "max-timeout-ms": { type: "string" },
    memory: { type: "string" },
    cpus: { type: "string" },
    pids: { type: "string" },
  },
});

// An omitted flag stays undefined, so the config schema applies its own default.
const numeric = (value: string | undefined) => (value === undefined ? undefined : Number(value));

const config = sandboxConfig(
  decodeBoundary(sandboxConfigSchema)({
    worktree: values.worktree,
    dockerContext: values["docker-context"],
    image: values.image,
    hostname: values.hostname,
    port: numeric(values.port),
    maxTimeoutMs: numeric(values["max-timeout-ms"]),
    memory: values.memory,
    cpus: numeric(values.cpus),
    pids: numeric(values.pids),
    token: process.env.LOOPY_SANDBOX_TOKEN,
  }),
);

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
