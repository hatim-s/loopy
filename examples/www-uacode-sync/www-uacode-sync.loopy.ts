import { command, trigger } from "loopy";

export type SyncInput = {
  dryRun: string;
};

export default trigger<SyncInput>("www-uacode-sync")
  .description(
    "Copy current www agent prompts and skills into uacode asset JSON, then open one PR per changed branch.",
  )
  .node("sync", ({ input }) =>
    command("bun", "run", "examples/www-uacode-sync/sync.ts", "--dry-run", input.dryRun),
  );
