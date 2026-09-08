import { randomUUID } from "node:crypto";
import { type ProviderId, TraceEventSchema } from "@loopy/contracts";

export function codingTrace(provider: ProviderId = "codex", command = "bun test") {
  const identity = {
    runId: randomUUID(),
    nodeId: randomUUID(),
    attemptId: randomUUID(),
    provider,
    sessionId: "source-session",
  };
  let sequence = 0;
  const event = (type: string, payload: unknown, toolCallId?: string) =>
    TraceEventSchema.parse({
      schemaVersion: "1",
      id: randomUUID(),
      ...identity,
      sequence: sequence++,
      occurredAt: "2026-09-08T00:00:00.000Z",
      monotonicOffsetMs: sequence,
      type,
      payload,
      ...(toolCallId ? { toolCallId } : {}),
    });
  const editId = randomUUID();
  const verifyId = randomUUID();
  const editTool = { codex: "apply_patch", claude: "Edit", pi: "write", opencode: "edit" }[
    provider
  ];
  const shellTool = { codex: "command", claude: "Bash", pi: "bash", opencode: "bash" }[provider];
  return [
    event("provider.message", {
      role: "user",
      content: "Implement greeting.ts greet(name), returning Hello plus the name, and test it.",
    }),
    event(
      "tool.requested",
      {
        tool: editTool,
        input: {
          path: "greeting.ts",
          content: "export const greet = (name: string) => `Hello, ${name}!`;",
        },
      },
      editId,
    ),
    event("tool.completed", { output: "File updated", exitCode: 0 }, editId),
    event("tool.requested", { tool: shellTool, input: { command } }, verifyId),
    event("tool.completed", { output: "2 pass, 0 fail", exitCode: 0 }, verifyId),
    event("provider.session_ended", { status: "succeeded" }),
  ];
}
