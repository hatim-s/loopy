import type { Prepare } from "../descriptor";
import { builtin, namespace, PATHS } from "./builtin";
import { CURL_WRITE_OUT, parseCurl } from "./parse/net";

const curlInput: Prepare = (input) => {
  const urls = (input.args?.length ?? 0) + (input.flags?.url === undefined ? 0 : 1);

  if (urls !== 1) {
    throw new Error("Parsed curl requires one URL. Use .raw() for multiple transfers.");
  }

  return input;
};

export const net = namespace("net", {
  curl: builtin(
    {
      preset: {
        flags: { silent: true, showError: true, dumpHeader: "-", writeOut: CURL_WRITE_OUT },
      },
      exclude: ["output", "include", "head"],
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
      positionals: PATHS,
    },
    {
      parse: parseCurl,
      out: {
        kind: "record",
        fields: {
          status: "number",
          headers: "json",
          body: "string",
          timeTotal: "number",
          sizeDownload: "number",
          url: "string",
        },
      },
      prepare: curlInput,
    },
  ),
});
