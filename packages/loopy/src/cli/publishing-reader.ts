import { dlopen, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { realpath } from "node:fs/promises";

/** Keep directory descriptors open while reading. Path replacement cannot change their targets. */
export async function manifestReader(directory: string) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Safe publishing file reads are unsupported on this platform");
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    },
  );
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  function openAt(parent: number, name: string, flags: number): number {
    const bytes = new TextEncoder().encode(`${name}\0`);
    const fd = library.symbols.openat(parent, ptr(bytes), flags);
    if (fd < 0)
      throw new Error(`Publishing file cannot be opened without following symlinks: ${name}`);
    return fd;
  }
  const canonical = await realpath(directory);
  let root = openSync("/", directoryFlags);
  try {
    for (const part of canonical.split("/").filter(Boolean)) {
      const next = openAt(root, part, directoryFlags);
      closeSync(root);
      root = next;
    }
  } catch (error) {
    closeSync(root);
    library.close();
    throw error;
  }
  return {
    read(path: string, limit: number): Uint8Array {
      const parts = path.split("/");
      if (parts.some((part) => !part || part === "." || part === ".."))
        throw new Error("Invalid publishing file path");
      const parents: number[] = [];
      let parent = root;
      let fd: number | undefined;
      try {
        for (const part of parts.slice(0, -1)) {
          parent = openAt(parent, part, directoryFlags);
          parents.push(parent);
        }
        const name = parts.at(-1);
        if (!name || parts.some((part) => !part || part === "." || part === ".."))
          throw new Error("Invalid publishing file path");
        fd = openAt(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!fstatSync(fd).isFile()) throw new Error("Publishing requires regular files");
        const bytes = new Uint8Array(limit + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, null);
          if (read === 0) break;
          count += read;
        }
        if (count > limit) throw new Error("Publishing file exceeds byte limits");
        return bytes.slice(0, count);
      } finally {
        if (fd !== undefined) closeSync(fd);
        for (const directory of parents.reverse()) closeSync(directory);
      }
    },
    close() {
      closeSync(root);
      library.close();
    },
  };
}
