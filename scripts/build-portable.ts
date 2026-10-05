const result = Bun.spawn(
  [
    process.execPath,
    "x",
    "--no-install",
    "tsc",
    "-p",
    "packages/loopy/tsconfig.portable-build.json",
  ],
  { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
);
if ((await result.exited) !== 0) throw new Error("Portable package build failed");
