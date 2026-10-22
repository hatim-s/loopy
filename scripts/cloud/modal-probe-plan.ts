import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const image =
  "oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6";

export const implementationFiles = [
  "modal-probe.ts",
  "modal-probe-plan.ts",
  "modal-probe-journal.ts",
  "modal-probe-run.ts",
  "modal-probe-gateway.ts",
  "modal-probe-worker.ts",
  "modal-probe-supervisor.ts",
] as const;

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const targetSchema = z
  .object({
    workspace: name,
    environment: name,
    expectedAppId: z
      .string()
      .regex(/^ap-[a-zA-Z0-9]+$/)
      .optional(),
    existingAppName: z
      .string()
      .regex(/^loopy-cloud-probe(?:-[a-z0-9-]+)?$/)
      .max(64)
      .optional(),
  })
  .strict()
  .refine((target) => Boolean(target.expectedAppId) === Boolean(target.existingAppName), {
    message: "existing-app-needs-exact-name-and-id",
  });

export const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{24}$/),
    target: targetSchema,
    implementationHash: digest,
    sdk: z.literal("modal@0.11.1"),
    speed: z.literal("Standard"),
    appName: z.string(),
    image: z.literal(image),
    resources: z
      .object({
        cpu: z.literal(0.5),
        cpuLimit: z.literal(0.5),
        memoryMiB: z.literal(512),
        memoryLimitMiB: z.literal(512),
        blockNetwork: z.literal(true),
      })
      .strict(),
    sandboxes: z.tuple([
      z
        .object({ role: z.literal("recovery"), name: z.string(), timeoutMs: z.literal(120000) })
        .strict(),
      z
        .object({ role: z.literal("lifetime"), name: z.string(), timeoutMs: z.literal(15000) })
        .strict(),
    ]),
    bounds: z
      .object({
        logicalSandboxCreates: z.literal(2),
        processTimeoutMs: z.literal(12000),
        outputBytes: z.literal(2048),
        wallTimeMs: z.literal(240000),
        sdkRetriesDisabled: z.literal(false),
        strictAllocationCapVerified: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

export type Role = Manifest["sandboxes"][number]["role"];

export type Target = z.infer<typeof targetSchema>;

export function plan(id: string, target: Target, implementationHash: string): Manifest {
  return manifestSchema.parse({
    version: 1,
    id,
    target,
    implementationHash,
    sdk: "modal@0.11.1",
    speed: "Standard",
    appName: target.existingAppName ?? `loopy-cloud-probe-${id}`,
    image,
    resources: { cpu: 0.5, cpuLimit: 0.5, memoryMiB: 512, memoryLimitMiB: 512, blockNetwork: true },
    sandboxes: [
      { role: "recovery", name: `loopy-probe-${id}-recovery`, timeoutMs: 120000 },
      { role: "lifetime", name: `loopy-probe-${id}-lifetime`, timeoutMs: 15000 },
    ],
    bounds: {
      logicalSandboxCreates: 2,
      processTimeoutMs: 12000,
      outputBytes: 2048,
      wallTimeMs: 240000,
      sdkRetriesDisabled: false,
      strictAllocationCapVerified: false,
    },
  });
}

export function hash(value: Manifest | Target): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseManifest(text: string): Manifest {
  const parsed = manifestSchema.parse(JSON.parse(text));
  const expected = plan(parsed.id, parsed.target, parsed.implementationHash);

  if (hash(parsed) !== hash(expected)) {
    throw new Error("manifest-policy-mismatch");
  }

  return parsed;
}

export const approvalSchema = z
  .object({
    approvedBy: z.literal("Hatim"),
    approvalReference: z.string().min(8).max(300),
    manifestHash: digest,
    cleanupImplementationHash: digest.optional(),
    target: targetSchema,
    appName: z.string(),
    approvedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    actions: z.array(z.enum(["execute", "inventory", "stop"])).min(1),
    acceptsUnverifiedWorkspaceIdentity: z.literal(true),
    acceptsSdkRetriesAndUnknownImageBuildCost: z.literal(true),
  })
  .strict();

export type Approval = z.infer<typeof approvalSchema>;

export type Action = z.infer<typeof approvalSchema>["actions"][number];

export function authorize(
  approval: Approval,
  manifest: Manifest,
  access: { action: Action | "verify"; now: number; implementationHash: string },
): void {
  const { action, now } = access;
  const requiredAction = action === "verify" ? "execute" : action;
  const start = Date.parse(approval.approvedAt);
  const end = Date.parse(approval.expiresAt);
  const reserve = action === "execute" ? manifest.bounds.wallTimeMs : 30000;

  if (
    approval.manifestHash !== hash(manifest) ||
    hash(approval.target) !== hash(manifest.target) ||
    approval.appName !== manifest.appName ||
    !approval.actions.includes(requiredAction) ||
    start > now ||
    end < now + reserve ||
    end - start > 86400000
  ) {
    throw new Error("approval-scope-or-expiry-mismatch");
  }

  if (requiredAction === "execute" && !approval.actions.includes("stop")) {
    throw new Error("approval-must-include-cleanup");
  }

  if (approval.cleanupImplementationHash && approval.actions.includes("execute")) {
    throw new Error("cleanup-approval-must-exclude-execute");
  }

  const cleanupOnly = action === "inventory" || action === "stop";

  const expected =
    cleanupOnly && !approval.actions.includes("execute")
      ? (approval.cleanupImplementationHash ?? manifest.implementationHash)
      : manifest.implementationHash;

  if (access.implementationHash !== expected) {
    throw new Error("implementation-hash-mismatch-fresh-approval-required");
  }
}

export function tags(manifest: Manifest, role: Role) {
  return { "loopy-probe": manifest.id, "loopy-manifest": hash(manifest), "loopy-role": role };
}

export async function implementationHash(directory: string): Promise<string> {
  const digest = createHash("sha256");

  for (const file of implementationFiles) {
    digest
      .update(file)
      .update("\n")
      .update(await readFile(join(directory, file)))
      .update("\n");
  }

  return digest.digest("hex");
}
