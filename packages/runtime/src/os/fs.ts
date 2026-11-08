import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { errnoCode } from "@loopy/core";

export function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/**
 * Serialises writers with a lock directory, since mkdir is atomic on every
 * filesystem. `holder` names the kind of work in the busy message.
 */
export function withLockDirectory<T>(lock: string, holder: string, work: () => T): T {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new Error(
        `Another ${holder} holds '${lock}'. If its process stopped, remove that lock directory and retry.`,
      );
    }

    throw error;
  }

  try {
    return work();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** Makes completed renames, links and unlinks in a directory survive a crash. */
export function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Creates a new file with complete, synced bytes. Fails with EEXIST when the path exists. */
export function writeExclusive(path: string, contents: string | Uint8Array, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );

  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replaces a file through a sibling temp file, so a reader sees the old or the new content. */
export function writeFileAtomically(
  file: string,
  contents: string | Uint8Array,
  mode: number,
): void {
  const temporary = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);

  try {
    writeExclusive(temporary, contents, mode);
    renameSync(temporary, file);
    chmodSync(file, mode);
    syncDirectory(dirname(file));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Publishes complete bytes at a path that must not exist yet. A hard link is atomic and exclusive,
 * so a reader never sees a partial file. Returns false when another writer published first.
 */
export function publishExclusive(
  path: string,
  contents: string | Uint8Array,
  mode: number,
): boolean {
  const directory = mkdtempSync(`${path}.publish-`);

  try {
    const temporary = join(directory, basename(path));
    writeExclusive(temporary, contents, mode);

    try {
      linkSync(temporary, path);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        return false;
      }

      throw error;
    }

    syncDirectory(dirname(path));

    return true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Reads a regular file of at most `limit` bytes without following a symlink. Missing is null. */
export function readRegularFile(path: string, limit: number): Buffer | null {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    const stats = fstatSync(fd);

    if (!stats.isFile() || stats.size > limit) {
      throw new Error(`'${path}' must be a regular file of at most ${limit} bytes.`);
    }

    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** EPERM means the process exists under another user, so only ESRCH proves it is gone. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") {
      return false;
    }

    if (errnoCode(error) === "EPERM") {
      return true;
    }

    throw error;
  }
}
