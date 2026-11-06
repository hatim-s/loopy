import { z } from "zod";
import { admissionSchema } from "../journal";

const inventorySchema = z.object({
  batch: z.string(),
  runs: z.array(z.object({ id: z.string(), status: z.enum(["succeeded", "failed"]) })).length(528),
});

export async function receiptInventory(options: {
  inventory: unknown;
  batch: string;
  journal: string;
}) {
  const inventory = inventorySchema.parse(options.inventory);
  const runs = new Map(inventory.runs.map((run) => [run.id, run.status]));

  if (inventory.batch !== options.batch || runs.size !== 528) {
    throw new Error("Receipt inventory requires 528 unique current-batch runs.");
  }

  const admitted = new Set<string>();

  for (const phase of ["primary", "preflight"] as const) {
    let count = 0;
    let successes = 0;

    for await (const file of new Bun.Glob(`${phase}/*/*.json`).scan({
      cwd: options.journal,
      absolute: true,
    })) {
      if (file.endsWith(".progress.json")) {
        continue;
      }

      const admission = admissionSchema.parse(await Bun.file(file).json());
      const batch = phase === "primary" ? options.batch : `${options.batch}-preflight`;

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
      count++;
      successes += Number(admission.expected === "succeeded");
    }

    if (
      count !== (phase === "primary" ? 525 : 3) ||
      successes !== (phase === "primary" ? 461 : 3)
    ) {
      throw new Error(`Receipt inventory has incomplete ${phase} admission evidence.`);
    }
  }

  return new Set(runs.keys());
}
