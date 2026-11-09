import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { DaemonInstallError, type DaemonOperations, daemonOperations } from "./install-files";
import { launchdManager, systemdManager } from "./managers";

type ServiceOptions = {
  platform?: string;
  userHome?: string;
  uid?: number;
  operations?: DaemonOperations;
};

type InstallOptions = ServiceOptions & {
  home: string;
  /** The complete service argv; the first entry is the absolute executable. */
  command: readonly [string, ...string[]];
  path?: string;
};

const serviceManager = Effect.fn(function* (options: ServiceOptions) {
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const operations = options.operations ?? daemonOperations;
  const uid = options.uid ?? process.getuid?.();

  if (platform === "linux") {
    return systemdManager({ userHome, operations });
  }

  if (platform === "darwin" && uid !== undefined) {
    return launchdManager({ userHome, uid, operations });
  }

  return yield* Effect.fail(
    new DaemonInstallError({
      message: "Daemon services require macOS or Linux. Run loopy daemon run under a supervisor.",
    }),
  );
});

const validateInstall = Effect.fn(function* (options: InstallOptions, path: string) {
  if (!isAbsolute(options.home) || !isAbsolute(options.command[0])) {
    return yield* Effect.fail(
      new DaemonInstallError({
        message:
          "Daemon paths must be absolute. Resolve the home and executable before installing.",
      }),
    );
  }

  if ([options.home, ...options.command, path].some((value) => /[\0\r\n]/.test(value))) {
    return yield* Effect.fail(
      new DaemonInstallError({
        message:
          "Service values cannot contain NUL or line breaks. Use paths and arguments without these characters.",
      }),
    );
  }
});

export function installDaemon(options: InstallOptions) {
  return Effect.gen(function* () {
    const manager = yield* serviceManager(options);
    const path = options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    yield* validateInstall(options, path);
    yield* (options.operations ?? daemonOperations).makeDirectory(join(options.home, "logs"));
    yield* manager.install({ home: options.home, command: options.command, path });
  });
}

export function uninstallDaemon(options: ServiceOptions = {}) {
  return Effect.flatMap(serviceManager(options), (manager) => manager.uninstall);
}
