import { expect, test } from "bun:test";
import { installDaemon } from "../src/local/daemon-install.js";
import {
  type DaemonOperations,
  daemonPlist,
  daemonUnit,
} from "../src/local/daemon-install-files.js";

test("macOS plist retains argv boundaries, escaped paths, environment and logs", () => {
  const content = daemonPlist(
    "/data/hatim & loopy",
    [
      "/opt/bun",
      "/opt/cli.js",
      "--concurrency",
      "7",
      "daemon",
      "run",
      "--home",
      "/data/hatim & loopy",
    ],
    "/opt/bin:/usr/bin",
  );

  expect(content).toContain("<string>/data/hatim &amp; loopy</string>");
  expect(content).toContain("<string>--concurrency</string><string>7</string>");
  expect(content).toContain("<key>WorkingDirectory</key><string>/data/hatim &amp; loopy</string>");
  expect(content).toContain("<key>RunAtLoad</key><true/>");
  expect(content).toContain("<key>KeepAlive</key><true/>");
  expect(content).toContain("<key>PATH</key><string>/opt/bin:/usr/bin</string>");

  for (const key of ["StandardOutPath", "StandardErrorPath"]) {
    expect(content).toContain(
      `<key>${key}</key><string>/data/hatim &amp; loopy/logs/daemon.log</string>`,
    );
  }
});

test("Linux unit escapes command expansion and supplies environment and persistent logs", () => {
  const content = daemonUnit(
    "/data/loopy % $HOME",
    ["/opt/bun", "/opt/cli with spaces.js", "daemon", "run", "--home", "/data/loopy % $HOME"],
    "/opt/bin:/usr/bin",
  );

  expect(content).toContain(
    'ExecStart="/opt/bun" "/opt/cli with spaces.js" "daemon" "run" "--home" "/data/loopy %% $$HOME"',
  );
  expect(content).toContain("Restart=always");
  expect(content).toContain("WorkingDirectory=/data/loopy %% $HOME");
  expect(content).toContain(
    'Environment="LOOPY_HOME=/data/loopy %% $HOME" "PATH=/opt/bin:/usr/bin"',
  );
  expect(content).toContain("StandardOutput=append:/data/loopy %% $HOME/logs/daemon.log");
  expect(content).toContain("StandardError=append:/data/loopy %% $HOME/logs/daemon.log");
});

test("install rejects relative paths and line injection before writing", async () => {
  const files: string[] = [];

  const operations: DaemonOperations = {
    writeFile: async (path) => {
      files.push(path);
    },
    exec: async () => {
      throw new Error("Invalid service values reached the supervisor.");
    },
  };

  const options = {
    platform: "linux",
    userHome: "/users/test",
    home: "/data/loopy",
    executable: "/opt/bun",
    args: ["/opt/cli.js"],
    path: "/opt/bin:/usr/bin",
    operations,
  };

  await expect(installDaemon({ ...options, executable: "bun" })).rejects.toThrow();
  await expect(installDaemon({ ...options, home: "/data/loopy\nRestart=no" })).rejects.toThrow();
  expect(files).toEqual([]);
});
