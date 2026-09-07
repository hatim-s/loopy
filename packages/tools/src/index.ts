import { homedir } from "node:os";
import { toolCatalog } from "./catalog";
import { type InstallOutcome, runInstaller } from "./process";

export type ToolStatus = {
  id: string;
  name: string;
  category: "agent" | "developer" | "shell" | "connector";
  installed: boolean;
  binary?: string;
  loginHint?: string;
  install?: { command: string; available: boolean; reason?: string };
};
export class ToolInstallError extends Error {
  constructor(
    readonly code:
      | "unknown_tool"
      | "install_busy"
      | "installer_unavailable"
      | "install_failed"
      | "verification_failed",
    message: string,
  ) {
    super(message);
  }
}
export function createToolRegistry(
  options: {
    which?: (binary: string) => string | null;
    run?: (argv: string[], cwd: string) => Promise<InstallOutcome>;
    platform?: NodeJS.Platform;
  } = {},
) {
  const which = options.which ?? Bun.which;
  const run = options.run ?? runInstaller;
  let pending: Promise<{ tool: ToolStatus; alreadyInstalled: boolean }> | undefined;
  const status = (id: string): ToolStatus => {
    const tool = toolCatalog.find((tool) => tool.id === id);
    if (!tool) throw new ToolInstallError("unknown_tool", `Unknown tool '${id}'`);
    const binary = which(tool.binary) ?? undefined;
    const supported =
      !tool.install?.platform || tool.install.platform === (options.platform ?? process.platform);
    const available = Boolean(supported && tool.install && which(tool.install.command));
    return {
      id: tool.id,
      name: tool.name,
      category: tool.category,
      installed: Boolean(binary),
      binary,
      loginHint: tool.loginHint,
      install: tool.install
        ? {
            command: [tool.install.command, ...tool.install.args].join(" "),
            available,
            reason: !supported
              ? "Installer is not supported on this operating system"
              : !available
                ? `${tool.install.command} is not on the server PATH`
                : undefined,
          }
        : undefined,
    };
  };
  return {
    list: () => toolCatalog.map((tool) => status(tool.id)),
    async install(id: string) {
      const tool = toolCatalog.find((tool) => tool.id === id);
      if (!tool) throw new ToolInstallError("unknown_tool", `Unknown tool '${id}'`);
      if (pending)
        throw new ToolInstallError(
          "install_busy",
          "Another CLI is installing. Wait for it to finish.",
        );
      const before = status(id);
      if (before.installed) return { tool: before, alreadyInstalled: true };
      const installer = tool.install && which(tool.install.command);
      if (!tool.install || !before.install?.available || !installer)
        throw new ToolInstallError(
          "installer_unavailable",
          before.install?.reason ?? "This tool has no managed installer",
        );
      const argv = [installer, ...tool.install.args];
      pending = (async () => {
        const result = await run(argv, homedir());
        if (result.exitCode !== 0 || result.timedOut)
          throw new ToolInstallError(
            "install_failed",
            result.timedOut
              ? "Installation timed out"
              : `Installer exited with code ${result.exitCode}`,
          );
        const after = status(id);
        if (!after.installed)
          throw new ToolInstallError(
            "verification_failed",
            "Installer finished, but the executable is not on the server PATH. Refresh after updating PATH.",
          );
        return { tool: after, alreadyInstalled: false };
      })();
      try {
        return await pending;
      } finally {
        pending = undefined;
      }
    },
    async drain() {
      await pending?.catch(() => undefined);
    },
  };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;
