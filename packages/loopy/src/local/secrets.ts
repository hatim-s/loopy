import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { secretNameSchema, secretValueSchema } from "../contract/index.js";
import { errnoCode, setOwnProperty } from "../core/index.js";
import { writeFileAtomically } from "../executor/index.js";
import { withLockDirectory } from "./fs.js";
import { homePaths } from "./home.js";
import { ServiceError } from "./service-error.js";

function assertOwned(stats: ReturnType<typeof fstatSync>, label: string): void {
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

const secretsSchema = z.record(secretNameSchema, secretValueSchema);

/** Plaintext storage protected by user-only permissions. No values are printed by the CLI. */
export class SecretStore {
  readonly directory: string;
  readonly file: string;

  constructor(home: string) {
    this.directory = resolve(home);
    this.file = homePaths(this.directory).secrets;
  }

  private directoryExists(create: boolean): boolean {
    if (create) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }

    let stats: ReturnType<typeof lstatSync>;

    try {
      stats = lstatSync(this.directory);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return false;
      }

      throw error;
    }

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("The secret directory must be a real directory, not a symlink.");
    }

    assertOwned(stats, "The secret directory");
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }

    return true;
  }

  private openStore(): number | undefined {
    try {
      return openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return undefined;
      }

      throw new Error("Cannot open the secret store. It must be a regular file, not a symlink.");
    }
  }

  snapshot(): Record<string, string> {
    if (!this.directoryExists(false)) {
      return {};
    }

    const fd = this.openStore();

    if (fd === undefined) {
      return {};
    }

    let value: unknown;

    try {
      const stats = fstatSync(fd);

      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error("The secret store must be a regular file with no hard links.");
      }

      assertOwned(stats, "The secret store");
      fchmodSync(fd, 0o600);

      try {
        value = JSON.parse(readFileSync(fd, "utf8"));
      } catch {
        throw new Error("The secret store contains invalid JSON.");
      }
    } finally {
      closeSync(fd);
    }

    return secretsSchema.parse(value);
  }

  list(): string[] {
    return Object.keys(this.snapshot()).sort();
  }

  get(name: string): string {
    secretNameSchema.parse(name);
    const values = this.snapshot();
    const value = Object.hasOwn(values, name) ? values[name] : undefined;

    if (value === undefined) {
      throw new ServiceError(
        "missing_secret",
        `No stored secret '${name}'. Use loopy secrets set ${name}.`,
      );
    }

    return value;
  }

  private async update(change: (values: Record<string, string>) => void): Promise<void> {
    this.directoryExists(true);
    await withLockDirectory(homePaths(this.directory).secretsLock, "secret update", async () => {
      const values = this.snapshot();
      change(values);
      await writeFileAtomically(this.file, `${JSON.stringify(values)}\n`, {
        mode: 0o600,
        syncDirectory: true,
      });
    });
  }

  async set(name: string, value: string): Promise<void> {
    secretNameSchema.parse(name);
    secretValueSchema.parse(value);
    await this.update((values) => setOwnProperty(values, name, value));
  }

  async remove(name: string): Promise<void> {
    secretNameSchema.parse(name);
    await this.update((values) => {
      delete values[name];
    });
  }
}
