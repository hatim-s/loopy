import { createLocalRuntime } from "../local/index.js";

export type LocalRuntime = ReturnType<typeof createLocalRuntime>;

/** Opens the run database for one command and closes it however the work ends. */
export async function withLocalRuntime<T>(
  home: string,
  work: (local: LocalRuntime) => Promise<T>,
): Promise<T> {
  const local = createLocalRuntime({ home });
  try {
    return await work(local);
  } finally {
    local.close();
  }
}
