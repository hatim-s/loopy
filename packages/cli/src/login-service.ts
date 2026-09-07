import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createSystemdService } from "./systemd-service";

export type ServiceCommand = (
  args: string[],
) => Promise<{ code: number; stderr: string; stdout?: string }>;
export type ServiceOptions = {
  configHome?: string;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  run?: ServiceCommand;
};
export type LoginConfiguration = {
  executable: string;
  cli: string;
  studioDir: string;
  path: string;
  port?: string;
};
const xml = (value: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 rejects these characters.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new Error("Login service paths cannot contain XML control characters");
  return value.replace(/[&<>"']/g, (character) => {
    return (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character] ??
      character
    );
  });
};
const runLaunchctl: ServiceCommand = async (args) => {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

// The caller supplies the canonical project path so symlink aliases share one service.
export function createLoginService(project: string, options: ServiceOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return createSystemdService(project, options);
  const supported = platform === "darwin";
  const home = options.home ?? homedir();
  const id = createHash("sha256").update(project).digest("hex").slice(0, 24);
  const label = `dev.loopy.server.${id}`;
  const domain = `gui/${options.uid ?? process.getuid?.()}`;
  const target = `${domain}/${label}`;
  const file = resolve(home, "Library/LaunchAgents", `${label}.plist`);
  const marker = `<!-- Loopy login service ${id} -->`;
  const run = options.run ?? runLaunchctl;
  function requireSupport() {
    if (!supported) throw new Error("Login auto-start supports macOS and Linux with systemd");
  }
  function installed() {
    if (!supported || !existsSync(file)) return false;
    if (!readFileSync(file, "utf8").includes(marker))
      throw new Error(`Refusing to change an unrecognized login service: ${file}`);
    return true;
  }
  async function loaded() {
    return (await run(["print", target])).code === 0;
  }
  async function command(args: string[]) {
    const result = await run(args);
    if (result.code !== 0)
      throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim() || result.code}`);
  }
  function definition(config: LoginConfiguration) {
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
    return `<?xml version="1.0" encoding="UTF-8"?>
${marker}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>${xml(config.path)}</string>
<key>HOME</key><string>${xml(home)}</string>
</dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  }
  return {
    installed,
    async status() {
      const enabled = installed();
      return {
        supported,
        enabled,
        loaded: enabled && (await loaded()),
        ...(enabled ? { file, label } : {}),
      };
    },
    async start() {
      requireSupport();
      if (!installed()) throw new Error("Enable login auto-start before starting its service");
      if (await loaded()) await command(["kickstart", target]);
      else await command(["bootstrap", domain, file]);
    },
    // Validate before draining an existing server or changing login configuration.
    prepare: (config: LoginConfiguration) => {
      requireSupport();
      if (
        config.port &&
        (!/^\d+$/.test(config.port) || Number(config.port) < 1 || Number(config.port) > 65535)
      )
        throw new Error("Login service port must be an integer between 1 and 65535");
      const content = definition(config);
      if (installed() && readFileSync(file, "utf8") !== content)
        throw new Error(
          "Disable auto-start before changing its Bun, CLI, Studio, PATH, or port configuration",
        );
      return content;
    },
    async install(content: string) {
      requireSupport();
      const existing = installed();
      if (!existing) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, { mode: 0o600, flag: "wx" });
      }
      try {
        await this.start();
      } catch (error) {
        // A failed registration must not silently enable a future login launch.
        if (!existing && !(await loaded())) rmSync(file);
        throw error;
      }
    },
    async uninstall() {
      requireSupport();
      if (!installed()) return;
      if (await loaded()) await command(["bootout", target]);
      rmSync(file);
    },
  };
}
