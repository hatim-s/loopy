import { expect, test } from "bun:test";
import { acceptanceProviders, runProductRecovery } from "./product-recovery";

for (const providerId of acceptanceProviders) {
  test(`offline ${providerId}: both branches, retry, verification and approval restart retain the agent`, async () => {
    let calls = 0;
    const result = await runProductRecovery({
      providerId,
      model: providerId === "codex" ? "gpt-5.6-luna" : "offline-fixture",
      provider: {
        async execute(context) {
          calls++;
          expect(context.node.provider).toBe(providerId);
          if (providerId === "codex") {
            expect(context.node.model).toBe("gpt-5.6-luna");
            expect(context.node.reasoning).toBe("low");
          }
          return {
            status: "succeeded",
            outputs: { message: context.input.text === "pass" ? "GREEN" : "RED" },
          };
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.mode).toBe("offline-scripted-provider");
    expect(result.cases.map((item) => item.status)).toEqual(["succeeded", "failed"]);
  }, 30000);
}
