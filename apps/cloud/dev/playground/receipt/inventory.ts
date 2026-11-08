import { phases, readAdmissions } from "../journal";
import type { PostloadInventory } from "../metrics/artifacts";
import type { PlanTotals } from "../plan";

export async function receiptInventory(options: {
  inventory: Pick<PostloadInventory, "batch" | "runs">;
  plan: PlanTotals;
  batch: string;
  journal: string;
}) {
  const { inventory, plan } = options;
  const runs = new Map(inventory.runs.map((run) => [run.id, run.status]));

  if (
    inventory.batch !== options.batch ||
    inventory.runs.length !== plan.runs ||
    runs.size !== plan.runs
  ) {
    throw new Error(`Receipt inventory requires ${plan.runs} unique current-batch runs.`);
  }

  const admitted = new Set<string>();

  for (const phase of phases) {
    const batch = phase === "primary" ? options.batch : `${options.batch}-preflight`;
    let successes = 0;
    const admissions = await readAdmissions(options.journal, phase);

    for (const admission of admissions) {
      if (
        admission.phase !== phase ||
        admission.input.batch !== batch ||
        admission.runId === null ||
        admission.admittedAt === null ||
        admitted.has(admission.runId) ||
        runs.get(admission.runId) !== admission.expected
      ) {
        throw new Error("Receipt inventory has an unresolved, duplicate or mismatched admission.");
      }

      admitted.add(admission.runId);
      successes += Number(admission.expected === "succeeded");
    }

    if (admissions.length !== plan[phase].runs || successes !== plan[phase].successes) {
      throw new Error(`Receipt inventory has incomplete ${phase} admission evidence.`);
    }
  }

  return new Set(runs.keys());
}
