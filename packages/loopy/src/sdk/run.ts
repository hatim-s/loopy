import type { Json } from "../core/index.js";
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
  clock?: Clock;
  signal?: AbortSignal;
};

type CreateOptions<Input, Output extends Json> = Omit<
  ActivationOptions<Input, Output>,
  "executor" | "signal"
> & {
  input: unknown;
  bundleHash: string;
  workspace: string;
};

// BOUNDARY: A host passes untyped input to a schema before creating a durable run.
export async function createLoopyRun<Input, Output extends Json>(
  options: CreateOptions<Input, Output>,
) {
  const { loopy, store, runId, bundleHash, workspace, clock = SYSTEM_CLOCK } = options;
  const input = await loopy.validateInput(options.input);
  assertJson(input, "Validated input");
  const at = new Date(clock.now()).toISOString();
  await store.createRun({
    id: runId,
    slug: loopy.name,
    bundleHash,
    workspace,
    input,
    status: "queued",
    createdAt: at,
    updatedAt: at,
  });
}

export async function startLoopy<Input, Output extends Json>(
  options: CreateOptions<Input, Output> &
    Pick<ActivationOptions<Input, Output>, "executor" | "signal">,
) {
  await createLoopyRun(options);

  return activateLoopy(options);
}

export async function activateLoopy<Input, Output extends Json>(
  options: ActivationOptions<Input, Output>,
) {
  const { loopy, store, executor, runId, clock, signal } = options;
  const run = await store.getRun(runId);

  if (!run) {
    throw new Error(`No run '${runId}'. Use loopy runs to list run ids.`);
  }

  return activate({
    store,
    executor,
    runId,
    cwd: run.workspace,
    clock,
    signal,
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
