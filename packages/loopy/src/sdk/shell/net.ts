import { descriptorCommand } from "../descriptor.js";
import type { RenderInput } from "../render-argv.js";
import { CURL_WRITE_OUT, parseCurl } from "./parse/net.js";

function curlInput(input: RenderInput): RenderInput {
  const urls = (input.args?.length ?? 0) + (input.flags?.url === undefined ? 0 : 1);

  if (urls !== 1) {
    throw new Error("Parsed curl requires one URL. Use .raw() for multiple transfers.");
  }

  return input;
}

export const net = {
  curl: descriptorCommand({
    parse: parseCurl,
    prepare: curlInput,
    preset: { flags: { silent: true, showError: true, dumpHeader: "-", writeOut: CURL_WRITE_OUT } },
    exclude: ["output", "include", "head"],
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
  }),
};
