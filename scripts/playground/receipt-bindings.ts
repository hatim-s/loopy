import { z } from "zod";

export const receiptBindingsSchema = z.object({
  durable_objects: z.object({
    bindings: z
      .array(z.object({ name: z.string(), class_name: z.string() }))
      .refine(
        (bindings) =>
          bindings.some(
            (binding) =>
              binding.name === "SANDBOX_RECEIPTS" && binding.class_name === "SandboxReceipts",
          ),
        "Architecture requires the SANDBOX_RECEIPTS binding to SandboxReceipts.",
      ),
  }),
  r2_buckets: z
    .array(z.object({ binding: z.string() }))
    .refine(
      (buckets) => buckets.some((bucket) => bucket.binding === "RECEIPT_RESULTS"),
      "Architecture requires the RECEIPT_RESULTS R2 binding.",
    ),
});
