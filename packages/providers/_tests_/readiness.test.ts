import { expect, test } from "bun:test";
import { authenticationStatus, createDefaultProviderRegistry, providerReadiness } from "../src";

test("installation and local authentication never claim verified run usability", () => {
  for (const provider of ["codex", "claude", "pi", "opencode"]) {
    expect(providerReadiness(provider, true).authentication).toBe("unknown");
    expect(providerReadiness(provider, true, "authenticated").usability).toBe("unverified");
    expect(providerReadiness(provider, false).installation).toBe("missing");
    expect(providerReadiness(provider, true).setupCommand.length).toBeGreaterThan(0);
  }
});

test("authentication evidence is parsed narrowly and raw output is never retained", () => {
  expect(authenticationStatus("codex", "Logged in using ChatGPT")).toBe("authenticated");
  expect(authenticationStatus("codex", "Not logged in")).toBe("unauthenticated");
  expect(authenticationStatus("codex", "0.1.0")).toBe("unknown");
  expect(authenticationStatus("claude", '{"loggedIn":false,"token":"secret"}')).toBe(
    "unauthenticated",
  );
  expect(authenticationStatus("claude", '{"loggedIn":true}')).toBe("authenticated");
  expect(authenticationStatus("claude", "unsupported command")).toBe("unknown");
});

test("all four reject network isolation before starting and preserve the caller policy", () => {
  const registry = createDefaultProviderRegistry();
  for (const adapter of registry.all()) {
    const request = {
      runId: "test",
      attemptId: "test",
      nodeId: "test",
      input: {},
      prompt: "test",
      policy: { tools: { network: "disabled" as const } },
    };
    const before = JSON.stringify(request);
    expect(() => adapter.validateRequest?.(request)).toThrow(/cannot enforce.*network policy/);
    expect(JSON.stringify(request)).toBe(before);
    expect(() =>
      adapter.validateRequest?.({ ...request, policy: { tools: { network: "unrestricted" } } }),
    ).not.toThrow();
  }
});

test("workflow policy validation finds conflicts without probing or creating a run", async () => {
  const { WorkflowDefinitionSchema } = await import("@loopy/contracts");
  const { validateWorkflowProviders, assertWorkflowProvidersReady } = await import("../src");
  const workflow = WorkflowDefinitionSchema.parse(
    await Bun.file(new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url)).json(),
  );
  const registry = createDefaultProviderRegistry();
  for (const adapter of registry.all())
    adapter.probe = () => {
      throw new Error("must not probe an incompatible workflow");
    };
  for (const provider of ["codex", "claude", "pi", "opencode"] as const) {
    workflow.defaults.provider = provider;
    workflow.policies.tools = { allow: [], deny: [], network: "disabled" };
    for (const node of workflow.nodes)
      if (node.kind === "agent") {
        node.provider = provider;
        node.requiredCapabilities = [];
      }
    const before = JSON.stringify(workflow);
    const diagnostics = validateWorkflowProviders(workflow, registry);
    expect(diagnostics[0]).toMatchObject({
      code: "PROVIDER_POLICY_UNSUPPORTED",
      severity: "error",
    });
    expect(diagnostics[0]?.message).toContain("network policy");
    await expect(assertWorkflowProvidersReady(workflow, registry)).rejects.toThrow(
      "network policy",
    );
    expect(JSON.stringify(workflow)).toBe(before);
  }
});
