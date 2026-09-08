import type { TraceEvent } from "@loopy/contracts";

const LOCAL_EDIT = /^(?:apply_patch|edit|write|multiedit|file_change)$/i;
const SHELL = /^(?:command|exec_command|bash|shell|execute)$/i;
const READ = /^(?:read|read_file|cat|glob|grep|rg|find|ls|pwd|git status|git diff)$/i;

export function observedCommand(event: TraceEvent): string | undefined {
  if (event.type !== "tool.requested" || !SHELL.test(event.payload.tool)) return;
  const input = event.payload.input;
  const raw =
    typeof input === "string"
      ? input
      : input && typeof input === "object" && !Array.isArray(input)
        ? (input.command ?? input.cmd)
        : undefined;
  if (typeof raw !== "string") return;
  // Unwrap only literal shells with a single quoted command. No interpolation is evaluated.
  const wrapper = raw.match(/^\/(?:bin|usr\/bin)\/(?:bash|zsh|sh) -lc '([^']*)'$/);
  return (wrapper?.[1] ?? raw).trim();
}

export function sameToolCall(request: TraceEvent, result: TraceEvent): boolean {
  return (
    Boolean(request.toolCallId) &&
    request.toolCallId === result.toolCallId &&
    request.runId === result.runId &&
    request.nodeId === result.nodeId &&
    request.attemptId === result.attemptId &&
    request.sessionId === result.sessionId &&
    result.sequence > request.sequence
  );
}

export function codingIntent(events: readonly TraceEvent[]) {
  const requests = events.filter(
    (event): event is Extract<TraceEvent, { type: "provider.message" }> =>
      event.type === "provider.message" &&
      event.payload.role === "user" &&
      Boolean(event.payload.content.trim()),
  );
  if (!requests.length) return;
  const edits = events.filter(
    (event) => event.type === "tool.requested" && LOCAL_EDIT.test(event.payload.tool),
  );
  const workspaceChange = events.some(
    (event) =>
      event.type === "workspace.file_change_summary" || event.type === "workspace.diff_created",
  );
  const explicitCodingTask = requests.some((event) =>
    /\b(?:implement|refactor|debug|code|function|typescript|javascript|unit test|bug|repository)\b/i.test(
      event.payload.content,
    ),
  );
  if (!edits.length && !workspaceChange && !explicitCodingTask) return;
  const blockers: string[] = [
    "Confirm that this workflow may edit files in its isolated project workspace for the supplied task.",
  ];
  if (!edits.length && !workspaceChange)
    blockers.push(
      "No local edit evidence was preserved. Confirm the implementation scope from the user request.",
    );
  if (requests.length > 1)
    blockers.push(
      "Multiple user instructions were observed. Review the task input example and choose the reusable scope.",
    );
  const terminal = events.filter((event) => event.type === "provider.session_ended").at(-1);
  if (!terminal || terminal.payload.status !== "succeeded")
    blockers.push(
      "The source session did not report successful completion. Review its incomplete work before reuse.",
    );
  for (const event of events) {
    if (event.redaction.status !== "none") blockers.push(`Source event ${event.id} is redacted.`);
    if (event.type === "tool.denied") blockers.push(`Source tool call ${event.id} was denied.`);
    if (event.type !== "tool.requested") continue;
    if (!events.some((result) => result.type === "tool.completed" && sameToolCall(event, result)))
      blockers.push(`Source tool call ${event.id} has no observed completion.`);
    const command = observedCommand(event);
    const accepted =
      LOCAL_EDIT.test(event.payload.tool) ||
      READ.test(event.payload.tool) ||
      (command !== undefined &&
        /^(?:(?:bun|npm|pnpm|yarn) test|(?:bun|npm|pnpm|yarn) run (?:lint|typecheck)|pwd|git status(?: --short)?|git diff(?: --stat)?)$/.test(
          command,
        ));
    if (!accepted)
      blockers.push(
        `Review source tool '${event.payload.tool}' at ${event.id}. Its operation is excluded from replay.`,
      );
  }
  for (const event of events) {
    if (
      event.type === "tool.completed" &&
      ((event.payload.exitCode !== undefined && event.payload.exitCode !== 0) ||
        (event.payload as Record<string, unknown>).isError === true)
    )
      blockers.push(
        `Source tool result ${event.id} reported failure. Confirm recovery or repair the task.`,
      );
  }
  return { request: requests[0]!, edits, blockers: [...new Set(blockers)] };
}
