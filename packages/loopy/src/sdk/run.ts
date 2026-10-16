import type { Json } from "../core/index.js";
import {
  activate,
  assertJson,
  type Clock,
  type Executor,
  type RunStore,
} from "../runtime/index.js";
import { WRAP } from "./current.js";
import type { Loopy } from "./loopy.js";

type RunOptions<Input, Output extends Json> = {
  loopy: Loopy<Input, Output>;
  input: unknown;
  store: RunStore;
  executor: Executor;
  runId: string;
  cwd: string;
  clock?: Clock;
};

// BOUNDARY: A CLI passes untyped input to a schema before it can create a durable run.
export async function runLoopy<Input, Output extends Json>(options: RunOptions<Input, Output>) {
  const { loopy, store, runId, input: value } = options;
  const input = await loopy.validateInput(value);
  assertJson(input, "Validated input");
  const at = new Date(options.clock?.now() ?? Date.now()).toISOString();
  await store.createRun({
    id: runId,
    slug: loopy.name,
    bundleHash: "",
    input,
    status: "queued",
    createdAt: at,
    updatedAt: at,
  });

  return activate({
    ...options,
    mode: loopy.mode,
    workflow: (context) => loopy.run({ ...context, input }),
    wrap: WRAP,
  });
}
