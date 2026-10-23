import type { RunOutcome, StoreEffect } from "../core/index.js";
import type { Effect, step } from "../engine/index.js";

export type ActivationWorkEffect = Extract<
  Effect,
  { kind: "dispatch" | "sample" | "schedule_retry" }
>;

type Disposition =
  | { kind: "active" }
  | { kind: "suspended" }
  | { kind: "finished"; outcome: RunOutcome };

export function planActivation(transition: ReturnType<typeof step>) {
  const retaining = transition.state.nodeRuns.some(
    (node) => node.status === "retrying" || node.status === "rate_limited",
  );

  const storeEffects: StoreEffect[] = [];
  const work: ActivationWorkEffect[] = [];

  for (const effect of transition.effects) {
    if (effect.kind === "dispatch" || effect.kind === "sample") {
      work.push(effect);
    } else if (!(effect.kind === "suspend_run" && retaining)) {
      storeEffects.push(effect);

      if (effect.kind === "schedule_retry") {
        work.push(effect);
      }
    }
  }

  const disposition: Disposition =
    transition.state.phase.kind === "finished"
      ? transition.state.phase
      : storeEffects.some((effect) => effect.kind === "suspend_run")
        ? { kind: "suspended" }
        : { kind: "active" };

  return { storeEffects, work, disposition };
}
