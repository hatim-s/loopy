import { parseArgs } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { PlaygroundClient } from "./client";
import { cohort, recover } from "./cohort";
import { profile } from "./config";
import { groupSchema } from "./journal";
import { arm, prepare } from "./prepare";
import { start, status, stop } from "./stack";
import { serve } from "./supervisor";

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

const decodeGroup = () => decodeBoundary(groupSchema)(values.group);

switch (positionals[0]) {
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
    await arm({
      profile,
      baseline: decodeBoundary(Schema.String.check(Schema.isMinLength(1)))(values.baseline),
      batch: (await PlaygroundClient.open()).settings.batch,
    });
    break;
  case "preflight":
    await cohort(decodeGroup(), "preflight");
    break;
  case "recover":
    await recover(decodeGroup());
    break;
  case "cohort":
    await cohort(decodeGroup());
    break;
  default:
    throw new Error(
      "Use start, stop, status, prepare, preflight --group a|b|c, arm --baseline <receipt>, cohort --group a|b|c or recover --group a|b|c. The supervisor runs serve itself.",
    );
}
