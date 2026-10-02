import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type BuildIdentity = {
  version: string;
  revision: string | null;
  modified: boolean | null;
  artifactSha256: string | null;
};

export const packageDirectory = resolve(import.meta.dir, "../..");

export function readBuildIdentity(
  directory = packageDirectory,
  metadata = join(directory, "dist/build-info.json"),
): BuildIdentity {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    version: string;
  };
  if (existsSync(metadata)) return JSON.parse(readFileSync(metadata, "utf8")) as BuildIdentity;
  return { version: manifest.version, revision: null, modified: null, artifactSha256: null };
}

export const runningBuildIdentity = () =>
  readBuildIdentity(packageDirectory, resolve(import.meta.dir, "../build-info.json"));
