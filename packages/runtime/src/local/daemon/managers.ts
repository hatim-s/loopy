import { join } from "node:path";
import { Effect } from "effect";
import { checkedExec, DaemonInstallError, type DaemonOperations } from "./install-files";

export type ServiceSpec = { home: string; command: readonly [string, ...string[]]; path: string };

/** One user service manager: where the definition lives, how it renders, starts and stops. */
export type ServiceManager = {
  install: (spec: ServiceSpec) => Effect.Effect<void, DaemonInstallError>;
  uninstall: Effect.Effect<void, DaemonInstallError>;
};

export function daemonLog(home: string): string {
  return join(home, "logs/daemon.log");
}

const LAUNCHD_LABEL = "com.loopy.daemon";

// bootout exits 3 or 113 when the service is not loaded; print exits 113 for an unknown service.
const LAUNCHD_NOT_LOADED = [3, 113];

const LAUNCHD_UNKNOWN = 113;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plist({ home, command, path }: ServiceSpec): string {
  const log = xml(daemonLog(home));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_LABEL}</string>
<key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

export function launchdManager(options: {
  userHome: string;
  uid: number;
  operations: DaemonOperations;
}): ServiceManager {
  const { operations } = options;
  const domain = `gui/${options.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const file = join(options.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);

  // Older launchctl lacks bootstrap and bootout, so both fall back to load and unload.
  const start = Effect.gen(function* () {
    yield* operations.exec(["launchctl", "bootout", target]);

    if ((yield* operations.exec(["launchctl", "bootstrap", domain, file])).code === 0) {
      return;
    }

    yield* operations.exec(["launchctl", "unload", "-w", file]);
    yield* checkedExec(operations, ["launchctl", "load", "-w", file]);

    if ((yield* operations.exec(["launchctl", "print", target])).code !== 0) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `Daemon did not load. Check launchctl print ${target} and the daemon logs, then retry installation.`,
        }),
      );
    }
  });

  const stop = Effect.gen(function* () {
    const { code } = yield* operations.exec(["launchctl", "bootout", target]);

    if (code === 0 || LAUNCHD_NOT_LOADED.includes(code)) {
      return;
    }

    yield* checkedExec(operations, ["launchctl", "unload", "-w", file]);

    if ((yield* operations.exec(["launchctl", "print", target])).code !== LAUNCHD_UNKNOWN) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `Cannot confirm the daemon was unloaded. Check launchctl print ${target} and retry uninstallation. The plist has been kept.`,
        }),
      );
    }
  });

  return {
    install: (spec) => operations.writeFile(file, plist(spec)).pipe(Effect.andThen(start)),
    uninstall: stop.pipe(Effect.andThen(operations.removeFile(file))),
  };
}

const SYSTEMD_UNIT = "loopy-daemon.service";

// systemctl exits 5 when the unit is not loaded.
const SYSTEMD_NOT_LOADED = 5;

function unitQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function unit({ home, command, path }: ServiceSpec): string {
  const log = daemonLog(home).replaceAll("%", "%%");

  return `[Unit]
Description=Loopy daemon

[Service]
ExecStart=${command.map((arg) => unitQuote(arg.replaceAll("$", () => "$$"))).join(" ")}
Restart=always
WorkingDirectory=${home.replaceAll("%", "%%")}
Environment=${unitQuote(`LOOPY_HOME=${home}`)} ${unitQuote(`PATH=${path}`)}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export function systemdManager(options: {
  userHome: string;
  operations: DaemonOperations;
}): ServiceManager {
  const { operations } = options;
  const file = join(options.userHome, ".config/systemd/user", SYSTEMD_UNIT);

  const systemctl = (...args: string[]) =>
    checkedExec(operations, ["systemctl", "--user", ...args]);

  const stop = Effect.gen(function* () {
    const { code } = yield* operations.exec([
      "systemctl",
      "--user",
      "disable",
      "--now",
      SYSTEMD_UNIT,
    ]);

    if (code !== 0 && code !== SYSTEMD_NOT_LOADED) {
      return yield* Effect.fail(
        new DaemonInstallError({
          message: `Cannot disable the daemon. Check systemctl --user status ${SYSTEMD_UNIT} and retry.`,
        }),
      );
    }
  });

  return {
    install: (spec) =>
      Effect.gen(function* () {
        yield* operations.writeFile(file, unit(spec));
        yield* systemctl("daemon-reload");
        yield* systemctl("enable", "--now", SYSTEMD_UNIT);
        yield* systemctl("restart", SYSTEMD_UNIT);
      }),
    uninstall: Effect.gen(function* () {
      yield* stop;
      yield* operations.removeFile(file);
      yield* systemctl("daemon-reload");
    }),
  };
}
