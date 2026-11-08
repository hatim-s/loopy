import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeBoundary } from "@loopy/contract";
import { errnoCode } from "@loopy/core";
import { Schema } from "effect";
import { within } from "../../../../packages/runtime/src/os/sandbox/paths";
import { profile, root as workspace } from "./config";
import { type Group, groups } from "./journal";
import { burstGroups, FIXTURES_PER_GROUP } from "./plan";

const execFileAsync = promisify(execFile);

const sourceRoot = join(workspace, "apps/cloud/dev/fixtures/playground");

const repository = profile.repository;

const relativeFile = Schema.String.check(
  Schema.makeFilter(
    (file) =>
      file.length > 0 &&
      !isAbsolute(file) &&
      !file.split(/[\\/]/).some((part) => part === ".." || part === "." || part.length === 0),
    { message: "file must be a normalized relative path" },
  ),
);

export const catalogSchema = Schema.Array(
  Schema.Struct({
    slug: Schema.String,
    file: relativeFile,
    description: Schema.String,
    approval: Schema.Boolean,
    artifactPath: Schema.NullOr(Schema.String),
    burst: Schema.Boolean,
  }),
);

export type CatalogEntry = (typeof catalogSchema.Type)[number];

const sourceMarker = ".playground-source-sha256";

const modulesPath = "modules/catalog.json";

// Only a missing path counts as absent; permission errors must surface.
async function lstatOrAbsent(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") {
      return undefined;
    }

    throw cause;
  }
}

export async function regularFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    const info = await lstat(path);

    if (info.isSymbolicLink()) {
      throw new Error(`Playground source contains a symlink: ${path}`);
    }

    if (info.isDirectory()) {
      paths.push(...(await regularFiles(path)));
    } else if (info.isFile()) {
      paths.push(path);
    } else {
      throw new Error(`Playground source contains a non-regular file: ${path}`);
    }
  }

  return paths;
}

async function readCatalog(group: Group, root: string): Promise<readonly CatalogEntry[]> {
  const data = await readFile(join(root, modulesPath), "utf8");
  const entries = decodeBoundary(catalogSchema)(JSON.parse(data));

  if (entries.length !== FIXTURES_PER_GROUP) {
    throw new Error(
      `Playground group ${group} must define exactly ${FIXTURES_PER_GROUP} catalog entries.`,
    );
  }

  const burstEntries = entries.filter((entry) => entry.burst);
  const burst = burstGroups[group];

  if (
    (!burst && burstEntries.length !== 0) ||
    (burst && (burstEntries.length !== 1 || entries[0]?.burst !== true))
  ) {
    throw new Error(`Playground group ${group} has an invalid burst fixture selection.`);
  }

  for (const entry of entries) {
    const file = resolve(root, entry.file);

    if (!within(root, file)) {
      throw new Error(`Catalog file escapes fixture group ${group}: ${entry.file}`);
    }

    const fileInfo = await lstatOrAbsent(file);

    if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(`Catalog file is missing or is not a regular file: ${entry.file}`);
    }

    if (!/\.(?:[cm]?ts|tsx|js|mjs|cjs)$/.test(entry.file)) {
      throw new Error(`Catalog fixture must be a source module: ${entry.file}`);
    }

    const source = await readFile(file, "utf8");

    if (!/(?:from\s*|import\s*\()\s*["']loopy\/graph["']/.test(source)) {
      throw new Error(`Catalog fixture must import loopy/graph as supplied: ${entry.file}`);
    }
  }

  return entries;
}

async function sourceSnapshot(): Promise<{
  hash: string;
  files: { source: string; target: string }[];
}> {
  const hash = createHash("sha256");
  const files: { source: string; target: string }[] = [];

  for (const group of groups) {
    const root = join(sourceRoot, group);

    const canonicalRoot = await realpath(root).catch(() => {
      throw new Error(`Playground source group is missing: ${root}`);
    });

    if (canonicalRoot !== root) {
      throw new Error(`Playground source group resolves outside its expected directory: ${root}`);
    }

    const groupFiles = await regularFiles(root);
    const catalogFile = join(root, modulesPath);

    if (!groupFiles.includes(catalogFile)) {
      throw new Error(`Playground group ${group} is missing a catalog.json`);
    }

    await readCatalog(group, root);

    for (const source of groupFiles) {
      const target = join("fixtures", group, relative(root, source));
      const content = await readFile(source);
      hash.update(`${group}\0${relative(root, source)}\0`);
      hash.update(content);
      files.push({ source, target });
    }
  }

  return { hash: hash.digest("hex"), files };
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Loopy Playground Fixture",
      "-c",
      "user.email=playground-fixture@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );

  return stdout.trim();
}

export async function prepareRepository(): Promise<{ commit: string; files: number }> {
  const snapshot = await sourceSnapshot();
  const existing = await lstatOrAbsent(repository);

  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error(`Playground repository path must be a real directory: ${repository}`);
  }

  if (existing) {
    const markerPath = join(repository, sourceMarker);

    const recordedHash = await readFile(markerPath, "utf8").catch(() => {
      throw new Error(`Refusing to replace existing playground repository without ${sourceMarker}`);
    });

    if (recordedHash.trim() !== snapshot.hash) {
      throw new Error(
        "Playground fixture sources changed after repository creation; refusing to overwrite the frozen repository.",
      );
    }

    const commit = await git(["rev-parse", "refs/loopy/playground-seed"]).catch(() => {
      throw new Error("Existing playground repository is missing its frozen seed commit.");
    });

    return { commit, files: snapshot.files.length + 4 };
  }

  await mkdir(repository, { recursive: true });

  try {
    for (const { source, target } of snapshot.files) {
      const destination = join(repository, target);

      if (!within(repository, resolve(destination))) {
        throw new Error(`Playground fixture path escapes repository: ${target}`);
      }

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(source), { flag: "wx" });
    }

    await writeFile(
      join(repository, "README.md"),
      "# Loopies playground\n\nLocal fixture repository for the Loopy playground driver.\n",
    );
    await writeFile(
      join(repository, "package.json"),
      '{\n  "name": "loopies-playground",\n  "private": true,\n  "type": "module"\n}\n',
    );
    await writeFile(join(repository, ".gitignore"), "node_modules/\n");
    await writeFile(join(repository, sourceMarker), `${snapshot.hash}\n`);

    await git(["init", "--initial-branch=playground"]);
    const dependencyDirectory = join(workspace, "node_modules");
    const dependencyInfo = await lstatOrAbsent(dependencyDirectory);

    if (dependencyInfo?.isDirectory() && !dependencyInfo.isSymbolicLink()) {
      await symlink(dependencyDirectory, join(repository, "node_modules"), "dir");
    }

    await git(["add", "README.md", "package.json", ".gitignore", sourceMarker, "fixtures"]);
    await git(["commit", "--no-gpg-sign", "-m", "Seed local playground fixtures"]);
    const commit = await git(["rev-parse", "HEAD"]);
    await git(["update-ref", "refs/loopy/playground-seed", commit]);

    return { commit, files: snapshot.files.length + 4 };
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}

export async function catalog(group: Group): Promise<readonly CatalogEntry[]> {
  const snapshot = await sourceSnapshot();
  const markerPath = join(repository, sourceMarker);

  const recordedHash = await readFile(markerPath, "utf8").catch(() => {
    throw new Error("Playground repository has not been prepared yet.");
  });

  if (recordedHash.trim() !== snapshot.hash) {
    throw new Error(
      "Playground fixture sources changed after repository creation; refusing to use stale catalog data.",
    );
  }

  return readCatalog(group, join(repository, "fixtures", group));
}

export async function catalogs(): Promise<Record<Group, readonly CatalogEntry[]>> {
  return { a: await catalog("a"), b: await catalog("b"), c: await catalog("c") };
}
