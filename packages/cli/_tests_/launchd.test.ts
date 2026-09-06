import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createLoginService } from "../src/login-service";
import { runningServer } from "../src/server";

// Opt in because this exercises a real per-user LaunchAgent, removed in finally.
test.skipIf(process.platform !== "darwin" || process.env.LOOPY_TEST_LAUNCHD !== "1")(
  "launchd takes over, restarts after a crash, honors stop, and unregisters cleanly",
  async () => {
    const project = realpathSync(mkdtempSync(resolve(tmpdir(), "loopy-launchd-")));
    writeFileSync(resolve(project, "index.html"), "<html><head></head><body>Loopy</body></html>");
    const cli = resolve(import.meta.dir, "../src/index.ts");
    const service = createLoginService(project);
    const command = async (action: string, success = true) => {
      const child = Bun.spawn(
        [process.execPath, cli, "server", action, "--project", project, "--studio-dir", project],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (success && code !== 0) throw new Error(`${action}: ${stderr || stdout}`);
      return { code, stdout };
    };
    try {
      const detached = JSON.parse((await command("start")).stdout) as { pid: number };
      const enabled = JSON.parse((await command("enable-autostart")).stdout) as {
        pid: number;
        autostart: { enabled: boolean; file: string };
      };
      expect(enabled.pid).not.toBe(detached.pid);
      expect(enabled.autostart.enabled).toBe(true);
      const plist = Bun.spawn(["/usr/bin/plutil", "-lint", enabled.autostart.file], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await plist.exited).toBe(0);
      const repeated = JSON.parse((await command("enable-autostart")).stdout) as { pid: number };
      expect(repeated.pid).toBe(enabled.pid);
      // Kill only the PID returned by our isolated, authenticated server.
      process.kill(enabled.pid, "SIGKILL");
      let recovered: Awaited<ReturnType<typeof runningServer>>;
      for (let attempt = 0; attempt < 200; attempt++) {
        recovered = await runningServer(project);
        if (recovered && recovered.pid !== enabled.pid) break;
        await Bun.sleep(100);
      }
      expect(recovered?.pid).toBeDefined();
      expect(recovered?.pid).not.toBe(enabled.pid);
      const restarted = JSON.parse((await command("restart")).stdout) as { pid: number };
      expect(restarted.pid).not.toBe(recovered?.pid);
      await command("stop");
      await Bun.sleep(1500);
      expect(await runningServer(project)).toBeUndefined();
      expect(await service.status()).toMatchObject({ enabled: true, loaded: true });
      await command("start");
      expect(await runningServer(project)).toBeDefined();
      await command("disable-autostart");
      expect(existsSync(enabled.autostart.file)).toBe(false);
      expect(await runningServer(project)).toBeUndefined();
    } catch (error) {
      const log = resolve(project, ".loopy/server.log");
      if (existsSync(log)) console.error(readFileSync(log, "utf8"));
      throw error;
    } finally {
      await command("stop", false);
      await service.uninstall();
      rmSync(project, { recursive: true, force: true });
    }
  },
  60_000,
);
