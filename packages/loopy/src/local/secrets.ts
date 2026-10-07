import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateSecretName } from "../core/names.js";
import { defaultHome } from "./registry.js";

export { validateSecretName } from "../core/names.js";

const MAX_VALUE_BYTES = 64 * 1024;

export function validateSecretValue(value: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    throw new Error("A secret must be nonempty, contain no NUL bytes, and fit within 64 KiB.");
  }
}

/** Keep default secrets outside the versioned graph store; custom homes stay isolated. */
export function secretDirectory(home = defaultHome()): string {
  const path = resolve(home);
  return path === join(homedir(), ".loopy", "v2") ? dirname(path) : path;
}

function owned(stats: ReturnType<typeof fstatSync>, label: string): void {
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

/** Plaintext storage protected by user-only permissions. No values are printed by the CLI. */
export class SecretStore {
  readonly directory: string;
  readonly file: string;

  constructor(home = defaultHome()) {
    this.directory = secretDirectory(home);
    this.file = join(this.directory, "secrets.json");
  }

  private directoryExists(create: boolean): boolean {
    if (create) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("The secret directory must be a real directory, not a symlink.");
    }
    owned(stats, "The secret directory");
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  snapshot(): Record<string, string> {
    if (!this.directoryExists(false)) {
      return {};
    }
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new Error("Cannot open the secret store. It must be a regular file, not a symlink.");
    }
    let value: unknown;
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error("The secret store must be a regular file with no hard links.");
      }
      owned(stats, "The secret store");
      fchmodSync(fd, 0o600);
      try {
        value = JSON.parse(readFileSync(fd, "utf8"));
      } catch {
        throw new Error("The secret store contains invalid JSON.");
      }
    } finally {
      closeSync(fd);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid secret store format.");
    }
    const entries = Object.entries(value);
    for (const [name, secret] of entries) {
      validateSecretName(name);
      if (typeof secret !== "string") {
        throw new Error("Invalid secret store value.");
      }
      validateSecretValue(secret);
    }
    return Object.fromEntries(entries) as Record<string, string>;
  }

  list(): string[] {
    return Object.keys(this.snapshot()).sort();
  }

  get(name: string): string {
    validateSecretName(name);
    const values = this.snapshot();
    if (!Object.hasOwn(values, name)) {
      throw new Error(`No stored secret '${name}'. Use loopy secrets set ${name}.`);
    }
    return values[name] as string;
  }

  private update(change: (values: Record<string, string>) => void): void {
    this.directoryExists(true);
    const lock = join(this.directory, ".secrets.lock");
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Another secret update holds '${lock}'. If its process stopped, remove that lock directory and retry.`,
        );
      }
      throw error;
    }
    const temporary = join(this.directory, `.secrets-${crypto.randomUUID()}.tmp`);
    try {
      const values = this.snapshot();
      change(values);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, `${JSON.stringify(values)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
      rmSync(lock, { recursive: true });
    }
  }

  set(name: string, value: string): void {
    validateSecretName(name);
    validateSecretValue(value);
    this.update((values) => {
      Object.defineProperty(values, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }

  remove(name: string): void {
    validateSecretName(name);
    this.update((values) => {
      delete values[name];
    });
  }
}
