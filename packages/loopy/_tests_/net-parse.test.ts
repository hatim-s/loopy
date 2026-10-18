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

test("curl skips proxy and repeated redirect statuses without consuming a body header", () => {
  const metadata = JSON.stringify({
    http_code: 302,
    num_redirects: 1,
    time_total: 0.1,
    size_download: 4,
    url_effective: "http://localhost/final",
  });

  const stdout = `HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 302 Found\r\nLocation: /final\r\n\r\nHTTP/1.1 302 Found\r\nX-Value: first\r\nX-Value: second\r\n\r\nHTTP/body\n__LOOPY_CURL__${
    metadata
  }`;

  expect(parseCurl(result(stdout))).toMatchObject({
    status: 302,
    headers: { "x-value": "first, second" },
    body: "HTTP/body",
  });
});
