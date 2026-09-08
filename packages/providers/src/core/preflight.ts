import type { WorkflowDefinition, WorkflowPatchDiagnostic } from "@loopy/contracts";
import type { ProviderRegistry } from "./types.js";

/** Check the exact command construction used by start, without executing it. */
export function validateWorkflowProviders(
  workflow: WorkflowDefinition,
  registry: ProviderRegistry,
): WorkflowPatchDiagnostic[] {
  const diagnostics: WorkflowPatchDiagnostic[] = [];
  for (const [index, node] of workflow.nodes.entries()) {
    if (node.kind !== "agent") continue;
    const provider = node.provider ?? workflow.defaults.provider;
    const adapter = registry.get(provider);
    try {
      if (!adapter) throw new Error(`Provider '${provider}' is not registered.`);
      if (!adapter.validateRequest) continue;
      for (const requirement of node.requiredCapabilities) {
        if (
          requirement.level === "required" &&
          adapter.capabilities().capabilities[requirement.capability]?.status !== "supported"
        )
          throw new Error(
            `${provider} does not support required capability '${requirement.capability}'. Choose a compatible provider or explicitly edit this requirement.`,
          );
      }
      adapter.validateRequest({
        runId: "preflight",
        attemptId: "preflight",
        nodeId: node.id,
        input: {},
        prompt: node.prompt,
        model: node.model ?? workflow.defaults.model,
        reasoning: node.reasoning ?? workflow.defaults.reasoning,
        policy: workflow.policies,
      });
    } catch (error) {
      diagnostics.push({
        code: "PROVIDER_POLICY_UNSUPPORTED",
        severity: "error",
        nodeId: node.id,
        path: `/nodes/${index}`,
        message: error instanceof Error ? error.message : "Provider request validation failed.",
      });
    }
  }
  return diagnostics;
}

export async function assertWorkflowProvidersReady(
  workflow: WorkflowDefinition,
  registry: ProviderRegistry,
): Promise<void> {
  const diagnostics = validateWorkflowProviders(workflow, registry);
  if (diagnostics.length)
    throw new Error(diagnostics.map((item) => `${item.nodeId}: ${item.message}`).join("\n"));
  const providers = new Set(
    workflow.nodes
      .filter((node) => node.kind === "agent")
      .map((node) => node.provider ?? workflow.defaults.provider),
  );
  for (const provider of providers) {
    const probe = await registry.get(provider)?.probe();
    if (!probe?.available)
      throw new Error(
        `${provider} CLI is unavailable. Install it on the server PATH and check provider setup again.`,
      );
    if (probe.readiness?.authentication === "unauthenticated")
      throw new Error(probe.readiness.message);
  }
}
