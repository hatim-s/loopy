import { test } from "bun:test";
import { Effect } from "effect";
import { actions, initialModel, type ModelAction, modelStep } from "./fixtures/host-policy-model";
import { replayPolicy, withFilePolicyStore } from "./fixtures/host-policy-replay";
import { memoryStore } from "./fixtures/stores";

for (const budget of [1, 2]) {
  test(`bounded independent host model, depth eight, budget ${budget}`, async () => {
    const initial = initialModel();
    const firstTrace: ModelAction[] = [];
    const queue = [{ state: initial, trace: firstTrace }];
    const seen = new Set([JSON.stringify(initial)]);
    let transitions = 0;
    const store = memoryStore({ leaseMs: 3000 });

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];

      if (!current || current.trace.length === 8) {
        continue;
      }

      for (const action of actions(current.state)) {
        const trace = [...current.trace, action];
        const next = modelStep(current.state, action).state;
        await replayPolicy(trace, store, `run-${transitions}`, budget);
        transitions++;
        const key = JSON.stringify(next);

        if (!seen.has(key)) {
          seen.add(key);
          queue.push({ state: next, trace });
        }
      }
    }

    await Effect.runPromise(store.close());
  }, 180_000);
}

const fileTraces: ModelAction[][] = [
  ["start_loss", "turn", "finish", "signal", "turn", "turn"],
  ["turn", "lookup_loss", "turn", "vanish", "turn", "turn"],
  [
    "turn",
    "retry",
    "turn",
    "advance",
    "turn",
    "advance",
    "turn",
    "signal",
    "finish",
    "turn",
    "turn",
  ],
  ["turn", "finish", "release_loss", "turn", "signal", "turn"],
  [
    "turn",
    "reconstruct",
    "turn",
    "advance",
    "advance",
    "advance",
    "advance",
    "advance",
    "turn",
    "finish",
    "turn",
  ],
];

for (const [index, trace] of fileTraces.entries()) {
  test(`representative file-backed host model trace ${index + 1}`, async () => {
    await withFilePolicyStore((store) => replayPolicy(trace, store, "run", (index % 2) + 1));
  });
}
