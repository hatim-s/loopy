const args = process.argv.slice(2);
const provider = args.includes("--json")
  ? "codex"
  : args.includes("--output-format")
    ? "claude"
    : args.includes("--format")
      ? "opencode"
      : "pi";
const rows =
  provider === "codex"
    ? [
        { type: "thread.started", thread_id: "fixture-session" },
        {
          type: "item.completed",
          thread_id: "fixture-session",
          item: { type: "agent_message", text: "fixture-visible" },
        },
        { type: "thread.completed", thread_id: "fixture-session", status: "succeeded" },
      ]
    : provider === "claude"
      ? [
          { type: "system", subtype: "init", session_id: "fixture-session" },
          {
            type: "assistant",
            session_id: "fixture-session",
            message: { role: "assistant", content: [{ type: "text", text: "fixture-visible" }] },
          },
          { type: "result", session_id: "fixture-session", subtype: "success", result: "done" },
        ]
      : provider === "opencode"
        ? [
            { type: "session_start", sessionID: "fixture-session" },
            { type: "message", sessionID: "fixture-session", part: { text: "fixture-visible" } },
            { type: "session_end", sessionID: "fixture-session" },
          ]
        : [
            { type: "session", sessionId: "fixture-session" },
            {
              type: "message_start",
              sessionId: "fixture-session",
              message: { role: "assistant", content: "fixture-visible" },
            },
            { type: "agent_end", sessionId: "fixture-session" },
          ];
for (const row of rows) console.log(JSON.stringify(row));
