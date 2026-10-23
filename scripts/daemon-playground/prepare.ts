import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { routes } from "../../packages/loopy/src/contract/index.ts";
import { catalogSchema } from "../playground/repository.ts";
import {
  cli,
  environment,
  home,
  port,
  root,
  selected,
  source,
  state,
  upstream,
  writeEvidence,
} from "./config.ts";
import { OwnedDaemon } from "./daemon.ts";

export async function treeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await treeFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Frozen source contains an unsupported entry: ${path}`);
    }
  }

  return files.sort();
}

export async function frozenHash(directory: string) {
  const hash = createHash("sha256");

  for (const path of await treeFiles(join(directory, "fixtures"))) {
    hash.update(`${relative(directory, path)}\0`);
    hash.update(await readFile(path));
  }

  return hash.digest("hex");
}

export async function selections() {
  return Promise.all(
    selected.map(async ({ group, slug }) => {
      const catalog = catalogSchema.parse(
        JSON.parse(await readFile(join(source, "fixtures", group, "modules/catalog.json"), "utf8")),
      );

      const entry = catalog.find((item) => item.slug === slug);

      if (!entry) {
        throw new Error(`Frozen catalog does not contain ${slug}.`);
      }

      return { ...entry, group, workspace: resolve(state, "workspaces", slug) };
    }),
  );
}

export async function prepare() {
  await mkdir(state, { recursive: true });
  const marker = await readFile(join(upstream, ".playground-source-sha256"), "utf8");
  const sourceExists = await lstat(source).catch(() => null);

  if (sourceExists) {
    if (
      !sourceExists.isDirectory() ||
      (await frozenHash(source)) !== (await frozenHash(upstream))
    ) {
      throw new Error("Existing isolated source differs from the frozen playground repository.");
    }
  } else {
    await mkdir(source);
    await cp(join(upstream, "fixtures"), join(source, "fixtures"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    for (const file of ["README.md", "package.json", ".playground-source-sha256"]) {
      await cp(join(upstream, file), join(source, file), { errorOnExist: true, force: false });
    }

    await symlink(join(root, "node_modules"), join(source, "node_modules"), "dir");
  }

  const selection = await selections();

  for (const entry of selection) {
    await mkdir(entry.workspace, { recursive: true });
    await mkdir(join(entry.workspace, ".loopy/loopies"), { recursive: true });
  }

  await mkdir(resolve(state, "process-home"), { recursive: true });
  const daemon = new OwnedDaemon();
  const revisions = [];

  try {
    await daemon.start();

    for (const entry of selection) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          cli,
          "--home",
          home,
          "--cwd",
          entry.workspace,
          "save",
          join(source, "fixtures", entry.group, entry.file),
        ],
        {
          cwd: root,
          env: environment(),
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      if (exitCode !== 0) {
        throw new Error(`Save failed for ${entry.slug}: ${stderr}`);
      }

      const query = new URLSearchParams({ workspace: entry.workspace });

      const saved = await daemon.request(
        `/loopies/${entry.slug}/graph?${query}`,
        routes.graph.response,
      );

      revisions.push({
        slug: entry.slug,
        revision: saved.revision,
        nodeCount: saved.graph.nodes.length,
      });
    }

    const manifest = {
      frozenAt: new Date().toISOString(),
      source,
      upstreamMarker: marker.trim(),
      sourceHash: await frozenHash(source),
      selections: selection,
      revisions,
      plannedRuns: 45,
      performedRuns: 0,
      mode: "actual Bun daemon with sandbox-exec on host OS",
      port,
      concurrency: 4,
      leaseMs: 2000,
    };

    await Bun.write(resolve(state, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeEvidence("-preflight", manifest);
  } finally {
    await daemon.stop();
  }
}

if (import.meta.main) {
  await prepare();
  console.log(
    "Frozen source compiled and saved through the public CLI. No runs started; daemon stopped.",
  );
}
