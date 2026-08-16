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
});
