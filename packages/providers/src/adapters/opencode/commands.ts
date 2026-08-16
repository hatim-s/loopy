import type { OpenCodeCommand, OpenCodeExportRequest, OpenCodeRunRequest } from "./types.js";
import { ensureArg } from "./util.js";

function option(command: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  ensureArg(value, flag);
  command.push(flag, value);
}

export function buildOpenCodeRunCommand(request: OpenCodeRunRequest): OpenCodeCommand {
  ensureArg(request.prompt, "prompt");
  if (request.fork && !request.sessionId) {
    throw new TypeError("OpenCode --fork requires an existing --session.");
  }
  if (request.auto && request.allowAuto !== true) {
    throw new Error("OpenCode --auto requires an explicit allowAuto policy.");
  }
  const args = ["run", "--format", "json"];
  option(args, "--model", request.model);
  option(args, "--agent", request.agent);
  option(args, "--session", request.sessionId);
  if (request.fork) args.push("--fork");
  option(args, "--dir", request.dir);
  option(args, "--variant", request.variant);
  if (request.auto) args.push("--auto");
  args.push(request.prompt);
  return { executable: "opencode", args };
}

export function buildOpenCodeSessionListCommand(): OpenCodeCommand {
  return { executable: "opencode", args: ["session", "list", "--format", "json"] };
}

export function buildOpenCodeExportCommand(request: OpenCodeExportRequest): OpenCodeCommand {
  ensureArg(request.sessionId, "sessionId");
  const args = ["export", request.sessionId];
  if (request.outputPath !== undefined) {
    ensureArg(request.outputPath, "outputPath");
    args.push(request.outputPath);
  }
  return { executable: "opencode", args };
}

export const createOpenCodeRunCommand = buildOpenCodeRunCommand;
