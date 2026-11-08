import { writeFileAtomically } from "@loopy/runtime/os";

/** Writes pretty JSON that a reader sees whole or not at all. */
export function atomic<T>(path: string, value: T) {
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}
