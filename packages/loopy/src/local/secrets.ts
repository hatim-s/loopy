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
import { join, resolve } from "node:path";
import { isString, requireRecord, setOwnProperty, validateSecretName } from "../core/index.js";
import { writeFileAtomically } from "../executor/index.js";
import { errnoCode, withLockDirectory } from "./fs.js";
import { defaultHome } from "./home.js";
import { ServiceError } from "./service-error.js";

const MAX_VALUE_BYTES = 64 * 1024;

export function validateSecretValue(value: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    throw new Error("A secret must be nonempty, contain no NUL bytes, and fit within 64 KiB.");
  }
}

function assertOwned(stats: ReturnType<typeof fstatSync>, label: string): void {
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

// BOUNDARY: The secrets.json file is checked for an object with valid secret names and bounded string values.
function parseSecrets(value: unknown) {
  const record = requireRecord(value, "The secret store");
  const secrets: Record<string, string> = {};

  for (const [name, secret] of Object.entries(record)) {
    validateSecretName(name);

    if (!isString(secret)) {
      throw new Error(`The secret store value for '${name}' must be a string.`);
    }

    validateSecretValue(secret);
    setOwnProperty(secrets, name, secret);
  }

  return secrets;
}

/** Plaintext storage protected by user-only permissions. No values are printed by the CLI. */
export class SecretStore {
  readonly directory: string;
  readonly file: string;

  constructor(home = defaultHome()) {
    this.directory = resolve(home);
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

    return parseSecrets(value);
  }

  list(): string[] {
    return Object.keys(this.snapshot()).sort();
  }

  get(name: string): string {
    validateSecretName(name);
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
    await withLockDirectory(join(this.directory, ".secrets.lock"), "secret update", async () => {
      const values = this.snapshot();
      change(values);
      await writeFileAtomically(this.file, `${JSON.stringify(values)}\n`, {
        mode: 0o600,
        syncDirectory: true,
      });
    });
  }

  async set(name: string, value: string): Promise<void> {
    validateSecretName(name);
    validateSecretValue(value);
    await this.update((values) => setOwnProperty(values, name, value));
  }

  async remove(name: string): Promise<void> {
    validateSecretName(name);
    await this.update((values) => {
      delete values[name];
    });
  }
}
