interface BundleOptions {
  readonly splitting?: boolean;
  /** Bun's entry naming template. Flat names let workerd load each entry by file name. */
  readonly naming?: string;
}

/**
 * Bundles entries for the browser target in a child bun. Inside bun test, the first in-process
 * Bun.build of a process cannot resolve some relative imports (store/sqlite/run-store.ts reaching
 * ../event-outbox) unless the test already loaded those modules, so a file passed only when an
 * earlier file had warmed the resolver. A child process has no such order dependency.
 */
export async function bundleForBrowser(
  entrypoints: readonly string[],
  outdir: string,
  { splitting = false, naming = "[name].[ext]" }: BundleOptions = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--target=browser",
      "--format=esm",
      `--entry-naming=${naming}`,
      ...(splitting ? ["--splitting"] : []),
      "--outdir",
      outdir,
      ...entrypoints,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  // Warnings print to stderr, and a bundle that warns is not the one production ships.
  if (code !== 0 || stderr.trim() !== "") {
    throw new Error(`bun build exited ${code} for ${entrypoints.join(", ")}:\n${stderr}`);
  }
}
