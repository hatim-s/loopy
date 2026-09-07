export type ToolDefinition = {
  id: string;
  name: string;
  binary: string;
  category: "agent" | "developer" | "shell" | "connector";
  loginHint?: string;
  install?: { command: string; args: string[]; platform?: NodeJS.Platform };
};
const bun = (name: string) => ({ command: "bun", args: ["add", "--global", name] });
const brew = (name: string) => ({ command: "brew", args: ["install", name] });

// Ported from Braidwork's local tool catalog; installation always uses fixed argv.
export const toolCatalog: readonly ToolDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    category: "agent",
    loginHint: "codex login",
    install: bun("@openai/codex"),
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    category: "agent",
    loginHint: "claude auth login",
    install: bun("@anthropic-ai/claude-code"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    category: "agent",
    loginHint: "opencode auth login",
    install: bun("opencode-ai"),
  },
  {
    id: "pi",
    name: "Pi",
    binary: "pi",
    category: "agent",
    loginHint: "pi",
    install: bun("@mariozechner/pi-coding-agent"),
  },
  { id: "git", name: "Git", binary: "git", category: "developer", install: brew("git") },
  {
    id: "gh",
    name: "GitHub CLI",
    binary: "gh",
    category: "developer",
    loginHint: "gh auth login",
    install: brew("gh"),
  },
  { id: "jq", name: "jq", binary: "jq", category: "shell", install: brew("jq") },
  { id: "rg", name: "ripgrep", binary: "rg", category: "shell", install: brew("ripgrep") },
  {
    id: "slack",
    name: "Slack CLI",
    binary: "slack",
    category: "connector",
    loginHint: "slack login",
    install: { command: "brew", args: ["install", "--cask", "slack-cli"], platform: "darwin" },
  },
  {
    id: "monday",
    name: "Monday.com CLI",
    binary: "mapps",
    category: "connector",
    loginHint: "mapps init",
    install: bun("@mondaycom/apps-cli"),
  },
  ...[
    "bash",
    "awk",
    "sed",
    "grep",
    "cut",
    "tr",
    "sort",
    "uniq",
    "head",
    "tail",
    "wc",
    "cat",
    "tee",
    "printf",
  ].map((binary): ToolDefinition => ({ id: binary, name: binary, binary, category: "shell" })),
];
