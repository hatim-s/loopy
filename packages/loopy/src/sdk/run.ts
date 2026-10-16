import type { EngineRun, Json } from "../core/index.js";
import {
  activate,
  assertJson,
  type Clock,
  type Executor,
  type RunStore,
  type LoopyContext as RuntimeContext,
  SYSTEM_CLOCK,
} from "../runtime/index.js";
import { log, now, random, uuid } from "./ambient.js";
import { stepScope, workflowScope } from "./current.js";
import type { Loopy } from "./loopy.js";

type ActivationOptions<Input, Output extends Json> = {
  loopy: Loopy<Input, Output>;
  store: RunStore;
  executor: Executor;
  runId: string;
  cwd: string;
  clock?: Clock;
};

type StartOptions<Input, Output extends Json> = ActivationOptions<Input, Output> & {
  input: unknown;
  bundleHash: string;
  detach?: boolean;
};

// BOUNDARY: A CLI passes untyped input to a schema before it can create a durable run.
export async function startLoopy<Input, Output extends Json>(options: StartOptions<Input, Output>) {
  const { loopy, store, runId, bundleHash, clock = SYSTEM_CLOCK } = options;
  const input = await loopy.validateInput(options.input);
  assertJson(input, "Validated input");
  const at = new Date(clock.now()).toISOString();
  await store.createRun({
    id: runId,
    slug: loopy.name,
    bundleHash,
    input,
    status: "queued",
    createdAt: at,
    updatedAt: at,
  });

  if (options.detach) {
    return { status: "queued" } satisfies Pick<EngineRun, "status">;
  }

  return activateLoopy(options);
}

export function activateLoopy<Input, Output extends Json>(
  options: ActivationOptions<Input, Output>,
) {
  const { loopy, store, executor, runId, cwd, clock } = options;

  return activate({
    store,
    executor,
    runId,
    cwd,
    clock,
    mode: loopy.mode,
    ...loopyActivation(loopy),
  });
}

export function loopyActivation<Input, Output extends Json>(loopy: Loopy<Input, Output>) {
  return {
    workflow: (context: RuntimeContext) => {
      // SAFETY: The stored run input was validated by this loopy before createRun.
      const input = context.input as Input;

      return loopy.run({ input, log, now, random, uuid });
    },
    wrap: { workflow: workflowScope, step: stepScope },
  };
}
