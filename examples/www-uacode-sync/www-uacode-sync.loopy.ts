import { loopy, sh } from "loopy";

export default loopy({
  name: "www-uacode-sync",
  description: "Copy www prompts and skills into uacode assets and open a PR per changed branch.",
  mode: "full",
  input: { dryRun: "boolean" },
  run: async ({ input, log }) => {
    const result = await sh.run(
      `bun run examples/www-uacode-sync/sync.ts --dry-run ${input.dryRun}`,
      { timeout: "1h", retry: { attempts: 1 } },
    );

    log.info("Prompt and skill synchronization completed.", { dryRun: input.dryRun });

    return { summary: result.stdout };
  },
});
