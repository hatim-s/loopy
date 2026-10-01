import { command, trigger } from "loopy";

export default trigger<{ requestFile: string }>("uacode-asset-sync")
  .description("Sync requested uacode assets in a disposable worktree and open a focused PR.")
  .node("sync", ({ input }) => ({
    ...command("bun", "examples/uacode-asset-sync/run.ts", input.requestFile),
    timeoutMs: 3_660_000,
    maxOutputBytes: 8 * 1024 * 1024,
  }));
