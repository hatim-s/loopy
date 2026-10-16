import { fs, loopy, sh } from "loopy";

export default loopy({
  name: "uacode-asset-sync",
  description: "Sync requested uacode assets in a disposable worktree and open a focused PR.",
  mode: "full",
  input: { requestFile: "string" },
  run: async ({ input, log }) => {
    const request = await fs.cat({ args: [input.requestFile] });

    const result = await sh.run("bun examples/uacode-asset-sync/run.ts -", {
      stdin: request.stdout,
      timeout: "61m",
      retry: { attempts: 1 },
    });

    log.info("Asset synchronization completed.");

    return { summary: result.stdout };
  },
});
