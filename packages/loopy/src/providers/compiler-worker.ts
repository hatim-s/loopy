import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { compileWorkflow } from "../core/workflow.js";
import { type PublishBundle, verifyPublishBundle } from "../publishing/manifest.js";

/** This entrypoint runs inside the compiler sandbox. Never invoke it in the API process. */
async function compileInSandbox(bundle: PublishBundle) {
  const verified = await verifyPublishBundle(bundle);
  if (
    verified.manifest.lockfile !== "bun.lock" ||
    !verified.manifest.files.includes("package.json")
  )
    throw new Error("Compiler requires declared package.json and bun.lock");
  const root = "/compile";
  for (const file of verified.files) {
    const destination = `${root}/${file.path}`;
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, file.content);
  }
  const install = Bun.spawn(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: root,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        BUN_INSTALL_CACHE_DIR: "/opt/loopy/dependency-cache",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  if ((await install.exited) !== 0)
    throw new Error("Pinned dependencies are unavailable in the compiler image cache");
  const module = await import(pathToFileURL(`${root}/${verified.manifest.entrypoint}`).href);
  return compileWorkflow(module.default);
}

if (import.meta.main) {
  try {
    const input: unknown = JSON.parse(await Bun.stdin.text());
    const workflow = await compileInSandbox(input as PublishBundle);
    await Bun.write("/compile-result.json", JSON.stringify({ workflow }));
  } catch {
    console.error("Isolated compilation failed");
    process.exitCode = 1;
  }
}
