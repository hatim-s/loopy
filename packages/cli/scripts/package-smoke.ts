import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const run = (args: string[], cwd: string, executable = process.execPath): string => {
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args.join(" ")}\n${output}`);
  return output;
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readLaunchUrl(process: Bun.Subprocess): Promise<string> {
  if (!process.stdout || typeof process.stdout === "number")
    throw new Error("Package smoke process did not expose stdout");
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 15_000;
  let pending = reader.read();
  while (Date.now() < deadline) {
    const timeout = Symbol("read-timeout");
    const result = await Promise.race([pending, sleep(250).then(() => timeout)]);
    if (typeof result === "symbol") continue;
    if (result.value) output += decoder.decode(result.value, { stream: true });
    const match = output.match(/Loopy Studio: (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match?.[1]) return match[1];
    if (result.done) break;
    pending = reader.read();
  }
  throw new Error(`Installed loopy ui did not start in time. Output:\n${output}`);
}

async function main(): Promise<void> {
  const packDir = mkdtempSync(join(tmpdir(), "loopy-pack-"));
  const projectDir = mkdtempSync(join(tmpdir(), "loopy-install-"));
  let server: Bun.Subprocess | undefined;
  try {
    const tarball = join(packDir, "loopy-smoke.tgz");
    const tarballOutput = run(["pm", "pack", "--filename", tarball, "--quiet"], packageRoot);
    if (!existsSync(tarball)) throw new Error(`Tarball was not created: ${tarballOutput}`);

    await Bun.write(
      join(projectDir, "package.json"),
      '{"name":"loopy-install-smoke","private":true}\n',
    );
    run(["add", "--no-save", tarball], projectDir);
    const installedBin = join(projectDir, "node_modules", ".bin", "loopy");
    if (!existsSync(installedBin)) throw new Error(`Installed bin was not linked: ${installedBin}`);

    server = Bun.spawn([installedBin, "ui", "--no-open", "--project", projectDir], {
      cwd: projectDir,
      stderr: "inherit",
      stdout: "pipe",
    });
    const baseUrl = await readLaunchUrl(server);
    const htmlResponse = await fetch(baseUrl);
    if (htmlResponse.status !== 200) throw new Error(`Studio HTML returned ${htmlResponse.status}`);
    const html = await htmlResponse.text();
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    if (!assetPaths.length) throw new Error("Studio HTML did not reference compiled assets");
    for (const assetPath of assetPaths) {
      const asset = await fetch(new URL(assetPath, baseUrl));
      if (asset.status !== 200)
        throw new Error(`Studio asset ${assetPath} returned ${asset.status}`);
    }

    const unauthenticated = await fetch(new URL("api/v1/health", baseUrl));
    if (unauthenticated.status !== 401)
      throw new Error(`Unauthenticated API returned ${unauthenticated.status}, expected 401`);
    const token = html.match(/"token":"([A-Za-z0-9_-]+)"/)?.[1];
    if (!token) throw new Error("Studio HTML did not contain an ephemeral session handoff");
    if (html.includes("?token=") || html.includes("&token=") || html.includes("localStorage"))
      throw new Error("Studio token leaked into a URL or persistent storage path");
    const authenticated = await fetch(new URL("api/v1/health", baseUrl), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (authenticated.status !== 200)
      throw new Error(`Authenticated API returned ${authenticated.status}, expected 200`);

    const entries = run(
      ["-tzf", tarball],
      packageRoot,
      process.platform === "darwin" ? "/usr/bin/tar" : "/bin/tar",
    );
    for (const forbidden of ["fixtures/", "secrets/", ".loopy", ".db", ".sqlite"]) {
      if (entries.includes(forbidden))
        throw new Error(`Tarball contains forbidden path: ${forbidden}`);
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      files?: string[];
    };
    if (JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md", "package.json"]))
      throw new Error("Package files allowlist changed unexpectedly");
    console.log("package tarball smoke: installed CLI served Studio assets and enforced API auth");
  } finally {
    server?.kill();
    if (server) await server.exited;
    rmSync(packDir, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  }
}

await main();
