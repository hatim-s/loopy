import { parseArgs } from "node:util";
import { Effect } from "effect";
import { z } from "zod";
import { cohort, recover } from "./cohort.js";
import { arm, prepare } from "./prepare.js";
import { serve, start, status, stop } from "./stack.js";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    group: { type: "string" },
    baseline: { type: "string" },
    profile: { type: "string" },
    "state-root": { type: "string" },
    "launch-nonce": { type: "string" },
  },
});

const command = positionals[0];

switch (command) {
  case "start":
    await start();
    break;
  case "serve":
    await serve({
      profile: values.profile,
      state: values["state-root"],
      nonce: values["launch-nonce"],
    });
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  case "prepare":
    await Effect.runPromise(prepare());
    break;
  case "arm":
    await arm(z.string().min(1).parse(values.baseline));
    break;
  case "preflight":
    await cohort(z.enum(["a", "b", "c"]).parse(values.group), "preflight");
    break;
  case "recover":
    await recover(z.enum(["a", "b", "c"]).parse(values.group));
    break;
  case "cohort":
    await cohort(z.enum(["a", "b", "c"]).parse(values.group));
    break;
  default:
    throw new Error(
      "Use start, stop, status, prepare, preflight --group a|b|c, arm --baseline <receipt>, or cohort --group a|b|c.",
    );
}
