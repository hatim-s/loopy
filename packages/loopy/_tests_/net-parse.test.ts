import { expect, test } from "bun:test";
import { parseCurl } from "../src/sdk/shell/parse/net.js";
import { fixture, result } from "./shell-parse-fixture.js";

test("curl capture separates headers, body marker text and metadata", async () => {
  expect(parseCurl(result(await fixture("net", "curl")))).toMatchObject({
    status: 200,
    headers: { "x-fixture": "yes" },
    body: "hello\n__LOOPY_CURL__body marker\n",
    timeTotal: expect.any(Number),
    sizeDownload: 32,
    url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
  });
});

test.each([
  "invalid",
  'HTTP/1.1 200 OK\r\nbad header\r\n\r\nbody\n__LOOPY_CURL__{"http_code":200,"time_total":0,"size_download":4,"url_effective":"http://localhost"}',
  "HTTP/1.1 200 OK\r\n\r\nbody\n__LOOPY_CURL__{}",
])("curl rejects malformed responses with an actionable error", (stdout) => {
  expect(() => parseCurl(result(stdout))).toThrow(
    /Unexpected curl output line: [\s\S]*\. Report this with the curl version\./,
  );
});
