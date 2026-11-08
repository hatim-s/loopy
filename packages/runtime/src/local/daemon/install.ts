import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { DaemonInstallError, daemonOperations } from "./install-files";
import { launchdManager, type ServiceSpec, systemdManager } from "./managers";

type InstallOptions = {
  home: string;
  /** The complete service argv; the first entry is the absolute executable. */
  command: readonly [string, ...string[]];
};

const serviceManager = Effect.suspend(() => {
  const userHome = homedir();
  const uid = process.getuid?.();

  if (process.platform === "linux") {
    return Effect.succeed(systemdManager({ userHome, operations: daemonOperations }));
  }

  if (process.platform === "darwin" && uid !== undefined) {
    return Effect.succeed(launchdManager({ userHome, uid, operations: daemonOperations }));
  }

  return Effect.fail(
    new DaemonInstallError({
      message: "Daemon services require macOS or Linux. Run loopy daemon run under a supervisor.",
    }),
  );
});

/** The service definition's values, refused before anything is written when a manager could misread them. */
export const serviceSpec = Effect.fn(function* (options: InstallOptions, path: string) {
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

  const spec: ServiceSpec = { home: options.home, command: options.command, path };

  return spec;
});

export function installDaemon(options: InstallOptions) {
  return Effect.gen(function* () {
    const manager = yield* serviceManager;
    const spec = yield* serviceSpec(options, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin");
    yield* daemonOperations.makeDirectory(join(options.home, "logs"));
    yield* manager.install(spec);
  });
}

export function uninstallDaemon() {
  return Effect.flatMap(serviceManager, (manager) => manager.uninstall);
}
