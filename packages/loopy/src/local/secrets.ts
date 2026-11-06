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
import { Effect } from "effect";
import { isString, requireRecord, setOwnProperty, validateSecretName } from "../core";
import { SecretError } from "../service";
import { errnoCode, withLockDirectory, writeFileAtomically } from "./fs";
import { defaultHome } from "./home";

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

  private readSnapshot(): Record<string, string> {
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

  snapshot() {
    return Effect.try({
      try: () => this.readSnapshot(),
      catch: (cause) => new SecretError({ operation: "read", reason: "io", cause }),
    });
  }
  list() {
    return this.snapshot().pipe(Effect.map((values) => Object.keys(values).sort()));
  }
  values(names: readonly string[]) {
    return this.snapshot().pipe(
      Effect.flatMap((snapshot) =>
        Effect.try({
          try: () => {
            const selected: Record<string, string> = {};

            for (const name of names) {
              const value = Object.hasOwn(snapshot, name) ? snapshot[name] : undefined;

              if (value === undefined) {
                throw new Error(`No stored secret '${name}'. Use loopy secrets set ${name}.`);
              }

              setOwnProperty(selected, name, value);
            }

            return selected;
          },
          catch: (cause) => new SecretError({ operation: "get", reason: "missing", cause }),
        }),
      ),
    );
  }
  private validate(name: string, value?: string) {
    return Effect.try({
      try: () => {
        validateSecretName(name);

        if (value !== undefined) {
          validateSecretValue(value);
        }
      },
      catch: (cause) => new SecretError({ operation: "validate", reason: "invalid", cause }),
    });
  }
  private update(change: (values: Record<string, string>) => void): void {
    this.directoryExists(true);
    withLockDirectory(join(this.directory, ".secrets.lock"), "secret update", () => {
      const values = this.readSnapshot();
      change(values);
      writeFileAtomically(this.file, `${JSON.stringify(values)}\n`, 0o600);
    });
  }

  set(name: string, value: string) {
    return this.validate(name, value).pipe(
      Effect.flatMap(() =>
        Effect.try({
          try: () => this.update((values) => setOwnProperty(values, name, value)),
          catch: (cause) => new SecretError({ operation: "set", reason: "io", cause }),
        }),
      ),
    );
  }
  remove(name: string) {
    return this.validate(name).pipe(
      Effect.flatMap(() =>
        Effect.try({
          try: () =>
            this.update((values) => {
              delete values[name];
            }),
          catch: (cause) => new SecretError({ operation: "remove", reason: "io", cause }),
        }),
      ),
    );
  }
}
