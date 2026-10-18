import { constants } from "node:fs";
import { chmod, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function syncDirectory(file: string) {
  const directory = await open(dirname(file), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeFileAtomically(
  file: string,
  contents: string | Uint8Array,
  options: { mode: number; syncDirectory: boolean },
): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);

  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      options.mode,
    );

    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, file);
    await chmod(file, options.mode);

    if (options.syncDirectory) {
      await syncDirectory(file);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
