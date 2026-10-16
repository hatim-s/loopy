import { defineCommand } from "../define-command.js";

export const net = {
  curl: defineCommand({
    namespace: "net",
    name: "curl",
    program: "curl",
    flags: {
      url: { cli: "--url", kind: "string" },
      request: { cli: "-X", kind: "string" },
      header: {
        cli: "-H",
        kind: "string",
        repeatable: true,
      },
      data: { cli: "--data", kind: "string" },
      dataRaw: { cli: "--data-raw", kind: "string" },
      output: { cli: "-o", kind: "string" },
      location: { cli: "-L", kind: "boolean" },
      silent: { cli: "-s", kind: "boolean" },
      showError: { cli: "-S", kind: "boolean" },
      fail: { cli: "-f", kind: "boolean" },
      maxTime: { cli: "--max-time", kind: "number" },
      writeOut: { cli: "-w", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
  }),
};
