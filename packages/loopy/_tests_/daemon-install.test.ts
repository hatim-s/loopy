import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPlist, daemonUnit, installDaemon } from "../src/local/daemon-install.js";

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

test("installer refuses invalid service values before writing files or starting services", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-install-boundary-"));

  const options = {
    platform: "darwin",
    userHome: join(root, "user"),
    uid: 1000,
    home: join(root, "home"),
    executable: "/opt/bun",
    path: "/usr/bin",
  } as const;

  try {
    await expect(installDaemon({ ...options, executable: "relative-bun" })).rejects.toThrow(
      "Daemon paths must be absolute.",
    );

    for (const value of ["bad\nvalue", "bad\rvalue", "bad\0value"]) {
      for (const invalid of [
        { args: [value] },
        { path: value },
        { home: `${root}/${value}` },
        { executable: `/opt/${value}` },
      ]) {
        await expect(installDaemon({ ...options, ...invalid })).rejects.toThrow(
          "Service values cannot contain NUL or line breaks.",
        );
      }
    }

    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
