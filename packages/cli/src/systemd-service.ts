import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { LoginConfiguration, ServiceCommand, ServiceOptions } from "./login-service";

// systemd expands % specifiers in all values. ExecStart uses ':' to suppress $ expansion.
function quote(value: string) {
  if ([...value].some((char) => char.charCodeAt(0) < 32))
    throw new Error("Login service paths cannot contain control characters");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function unitPath(value: string) {
  quote(value);
  if (/[\s\\]$/.test(value))
    throw new Error("Systemd service paths cannot end in whitespace or a backslash");
  return value.replaceAll("%", "%%");
}
const runSystemctl: ServiceCommand = async (args) => {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};
export function createSystemdService(project: string, options: ServiceOptions) {
  const home = options.home ?? homedir();
  const configured = options.configHome ?? process.env.XDG_CONFIG_HOME;
  const configHome = configured && isAbsolute(configured) ? configured : resolve(home, ".config");
  const id = createHash("sha256").update(project).digest("hex").slice(0, 24);
  const label = `dev.loopy.server.${id}.service`;
  const file = resolve(configHome, "systemd/user", label);
  const marker = `# Loopy login service ${id}`;
  const run = options.run ?? runSystemctl;
  function installed() {
    if (!existsSync(file)) return false;
    if (!readFileSync(file, "utf8").startsWith(`${marker}\n`))
      throw new Error(`Refusing to change an unrecognized login service: ${file}`);
    return true;
  }
  async function command(args: string[]) {
    const result = await run(args);
    if (result.code !== 0)
      throw new Error(
        `systemctl --user ${args[0]} failed: ${result.stderr.trim() || result.code}. A systemd user session is required.`,
      );
  }
  return {
    installed,
    async status() {
      const registered = installed();
      const enabled = registered && (await run(["is-enabled", label])).code === 0;
      const loaded =
        registered &&
        (await run(["show", label, "--property=LoadState", "--value"])).stdout?.trim() === "loaded";
      return { supported: true, enabled, loaded, ...(registered ? { file, label } : {}) };
    },
    prepare(config: LoginConfiguration) {
      if (
        config.port &&
        (!/^\d+$/.test(config.port) || Number(config.port) < 1 || Number(config.port) > 65535)
      )
        throw new Error("Login service port must be an integer between 1 and 65535");
      const argv = [
        config.executable,
        config.cli,
        "server",
        "serve",
        "--project",
        project,
        "--studio-dir",
        config.studioDir,
        ...(config.port ? ["--port", config.port] : []),
      ];
      const log = resolve(project, ".loopy/server.log");
      const content = `${marker}
[Unit]
Description=Loopy project server
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=:${argv.map(quote).join(" ")}
WorkingDirectory=${unitPath(project)}
Environment=${quote(`PATH=${config.path}`)} ${quote(`HOME=${home}`)}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=60
UMask=0077
StandardOutput=append:${unitPath(log)}
StandardError=append:${unitPath(log)}

[Install]
WantedBy=default.target
`;
      if (installed() && readFileSync(file, "utf8") !== content)
        throw new Error(
          "Disable auto-start before changing its Bun, CLI, Studio, PATH, or port configuration",
        );
      return content;
    },
    async start() {
      if (!installed()) throw new Error("Enable login auto-start before starting its service");
      await command(["start", label]);
    },
    async install(content: string) {
      const existing = installed();
      if (!existing) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, { mode: 0o600, flag: "wx" });
      }
      try {
        await command(["daemon-reload"]);
        await command(["enable", label]);
        await this.start();
      } catch (error) {
        if (!existing) {
          // Disable first; retain the file if rollback cannot remove the registration.
          const rollback = await run(["disable", "--now", label]);
          if (rollback.code === 0) {
            rmSync(file);
            await run(["daemon-reload"]);
          }
        }
        throw error;
      }
    },
    async uninstall() {
      if (!installed()) return;
      await command(["disable", "--now", label]);
      rmSync(file);
      await command(["daemon-reload"]);
    },
  };
}
