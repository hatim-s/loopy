import { net as runtime } from "../../shell/net.js";
import { defineCommand } from "./command.js";

export const net = {
  curl: defineCommand(
    { ...runtime.curl.descriptor, parse: "./parsers/net-curl.ts" },
    {
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
  ),
};
