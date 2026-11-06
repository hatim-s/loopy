import { net as runtime } from "../../shell/net";
import { defineCommand } from "./command";

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
