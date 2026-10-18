import type { CommandDescriptor } from "../define-command.js";
import { defineCommands } from "../graph/nodes/command.js";
import { refuse } from "../graph/validate.js";
import { parseCurlOut } from "./parse/net.js";

export const netDescriptors = {
  curl: {
    preset: {
      flags: {
        silent: true,
        showError: true,
        dumpHeader: "-",
        writeOut: "\n__LOOPY_CURL__%{json}",
      },
    },
    exclude: ["output", "include", "head"],
    program: "curl",
    flags: {
      url: { cli: "--url", kind: "string" },
      request: { cli: "-X", kind: "string" },
      header: { cli: "-H", kind: "string", repeatable: true },
      data: { cli: "--data", kind: "string" },
      dataRaw: { cli: "--data-raw", kind: "string" },
      dumpHeader: { cli: "-D", kind: "string" },
      include: { cli: "-i", kind: "boolean" },
      head: { cli: "-I", kind: "boolean" },
      output: { cli: "-o", kind: "string" },
      location: { cli: "-L", kind: "boolean" },
      silent: { cli: "-s", kind: "boolean" },
      showError: { cli: "-S", kind: "boolean" },
      fail: { cli: "-f", kind: "boolean" },
      maxTime: { cli: "--max-time", kind: "number" },
      writeOut: { cli: "-w", kind: "string" },
    },
    positionals: [{ name: "paths", optional: true, variadic: true }],
    key: "net.curl",
    parse: "./parsers/net-curl.ts",
    out: parseCurlOut,
    prepare: ({ args, flags }) => {
      if (args + Number(flags.has("url")) !== 1) {
        refuse("arity", "Parsed curl requires one URL. Use .raw() for multiple transfers.");
      }

      return {};
    },
  },
} as const satisfies Record<string, CommandDescriptor>;

export const net = defineCommands(netDescriptors);
