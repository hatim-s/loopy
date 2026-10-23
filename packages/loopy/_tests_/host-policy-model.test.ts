import { test } from "bun:test";
import { actions, initialModel, type ModelAction, modelStep } from "./host-policy-model.js";
import { replayPolicy } from "./host-policy-replay.js";

for (const budget of [1, 2]) {
  test(`bounded independent host model, depth eight, budget ${budget}`, async () => {
    const initial = initialModel();
    const firstTrace: ModelAction[] = [];
    const queue = [{ state: initial, trace: firstTrace }];
    const seen = new Set([JSON.stringify(initial)]);
    let transitions = 0;

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];

      if (!current || current.trace.length === 8) {
        continue;
      }

      for (const action of actions(current.state)) {
        const trace = [...current.trace, action];
        const next = modelStep(current.state, action).state;
        await replayPolicy(trace, "memory", budget);
        transitions++;
        const key = JSON.stringify(next);

        if (!seen.has(key)) {
          seen.add(key);
          queue.push({ state: next, trace });
        }
      }
    }

    console.log(
      `host model budget=${budget} depth=8 states=${seen.size} transitions=${transitions} shortest counterexample=none`,
    );
  }, 60_000);
}

const sqlTraces: ModelAction[][] = [
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

for (const [index, trace] of sqlTraces.entries()) {
  test(`representative SQL host model trace ${index + 1}`, async () => {
    await replayPolicy(trace, "sqlite", (index % 2) + 1);
  });
}
