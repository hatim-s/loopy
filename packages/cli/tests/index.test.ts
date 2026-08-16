import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/index";

describe("loopy CLI shell", () => {
  it("prints a version without invoking an unimplemented command", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(main(["--version"])).toBe(0);
    expect(output).toHaveBeenCalledWith("0.1.0");

    output.mockRestore();
  });

  it("returns a non-zero status for planned but unimplemented commands", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(main(["run"])).toBe(2);
    expect(error).toHaveBeenCalledWith("loopy: 'run' is not implemented in this release.");

    error.mockRestore();
  });

  it("executes the package bin entry point directly", () => {
    const packageDirectory = resolve(fileURLToPath(import.meta.url), "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
    ) as { bin: { loopy: string } };
    const result = spawnSync(resolve(packageDirectory, packageJson.bin.loopy), ["--version"], {
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });
});
