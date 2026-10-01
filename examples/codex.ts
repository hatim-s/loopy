import { type CommandDescriptor, defineCommand } from "loopy";

const descriptor = {
  program: "codex",
  path: ["exec"],
  positionals: [
    {
      name: "prompt",
      optional: true,
    },
  ],
  flags: {
    config: {
      cli: "--config",
      kind: "string",
    },
    enable: {
      cli: "--enable",
      kind: "string",
      repeatable: true,
    },
    disable: {
      cli: "--disable",
      kind: "string",
      repeatable: true,
    },
    strictConfig: {
      cli: "--strict-config",
      kind: "boolean",
    },
    image: {
      cli: "--image",
      kind: "string",
      repeatable: true,
    },
    model: {
      cli: "--model",
      kind: "string",
    },
    oss: {
      cli: "--oss",
      kind: "boolean",
    },
    localProvider: {
      cli: "--local-provider",
      kind: "string",
    },
    profile: {
      cli: "--profile",
      kind: "string",
    },
    sandbox: {
      cli: "--sandbox",
      kind: "string",
      choices: ["read-only", "workspace-write", "danger-full-access"],
    },
    approveForMe: {
      cli: "--approve-for-me",
      kind: "boolean",
    },
    dangerouslyBypassApprovalsAndSandbox: {
      cli: "--dangerously-bypass-approvals-and-sandbox",
      kind: "boolean",
    },
    dangerouslyBypassHookTrust: {
      cli: "--dangerously-bypass-hook-trust",
      kind: "boolean",
    },
    cd: {
      cli: "--cd",
      kind: "string",
    },
    worktree: {
      cli: "--worktree",
      kind: "boolean",
    },
    addDir: {
      cli: "--add-dir",
      kind: "string",
    },
    threadSource: {
      cli: "--thread-source",
      kind: "string",
    },
    skipGitRepoCheck: {
      cli: "--skip-git-repo-check",
      kind: "boolean",
    },
    ephemeral: {
      cli: "--ephemeral",
      kind: "boolean",
    },
    ignoreUserConfig: {
      cli: "--ignore-user-config",
      kind: "boolean",
    },
    ignoreRules: {
      cli: "--ignore-rules",
      kind: "boolean",
    },
    outputSchema: {
      cli: "--output-schema",
      kind: "string",
    },
    color: {
      cli: "--color",
      kind: "string",
      choices: ["always", "never", "auto"],
    },
    json: {
      cli: "--json",
      kind: "boolean",
    },
    outputLastMessage: {
      cli: "--output-last-message",
      kind: "string",
    },
    help: {
      cli: "--help",
      kind: "boolean",
    },
    version: {
      cli: "--version",
      kind: "boolean",
    },
  },
  helpHash: "276bc59ad4bf2ba65d85878940a67530be28477169fca42ca8dc73f18226b91e",
  observedVersion: "codex-cli 0.156.1",
} as const satisfies CommandDescriptor;

export const codexExec = defineCommand(descriptor);
