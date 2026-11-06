import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type Manifest, parseManifest } from "./plan";

const recordSchema = z
  .object({
    at: z.number().int().nonnegative(),
    id: z
      .string()
      .regex(/^(ap|sb)-[a-zA-Z0-9]+$/)
      .optional(),
    code: z.string().max(80).optional(),
  })
  .strict();

type RecordData = z.infer<typeof recordSchema>;

export type Entry =
  | "execution-started"
  | "app-intent"
  | "app-created"
  | "recovery-intent"
  | "recovery-created"
  | "recovery-terminated"
  | "effect-intent"
  | "recovery-passed"
  | "lifetime-intent"
  | "lifetime-created"
  | "lifetime-terminated"
  | "lifetime-passed"
  | "worker-failed";

export async function readPrivateText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const info = await file.stat();

    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error("private-file-required");
    }

    if (info.size > 16384) {
      throw new Error("private-input-too-large");
    }

    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function readPrivate<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readPrivateText(path)));
}

async function writeExclusive(path: string, value: Manifest | RecordData): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);

  try {
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }

    // A killed writer can leave a temporary file, never a partial published record.
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }

  const directory = await open(resolve(path, ".."), constants.O_RDONLY);

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class Journal {
  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
  ) {}

  static async create(root: string, manifest: Manifest): Promise<Journal> {
    const canonicalRoot = await realpath(root);
    const base = resolve(canonicalRoot, ".loopy/cloud-probe");

    for (const directory of [resolve(canonicalRoot, ".loopy"), base]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });

      if ((await realpath(directory)) !== directory) {
        throw new Error("journal-symlink-refused");
      }
    }

    const directory = join(base, manifest.id);
    await mkdir(directory, { mode: 0o700 });
    await writeExclusive(join(directory, "manifest.json"), manifest);
    const parent = await open(base, constants.O_RDONLY);

    try {
      await parent.sync();
    } finally {
      await parent.close();
    }

    return new Journal(directory, manifest);
  }

  static async load(root: string, id: string): Promise<Journal> {
    if (!/^[a-f0-9]{24}$/.test(id)) {
      throw new Error("invalid-plan-id");
    }

    const directory = resolve(await realpath(root), ".loopy/cloud-probe", id);
    const info = await stat(directory);

    if (
      (await realpath(directory)) !== directory ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    ) {
      throw new Error("private-journal-directory-required");
    }

    const manifest = parseManifest(await readPrivateText(join(directory, "manifest.json")));

    if (manifest.id !== id) {
      throw new Error("journal-identity-mismatch");
    }

    return new Journal(directory, manifest);
  }

  async put(entry: Entry, record: RecordData = { at: Date.now() }): Promise<void> {
    await writeExclusive(join(this.directory, `${entry}.json`), recordSchema.parse(record));
  }

  async get(entry: Entry): Promise<RecordData | null> {
    try {
      return await readPrivate(join(this.directory, `${entry}.json`), recordSchema);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }
}
