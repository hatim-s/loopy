import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRunStore } from "../src/runtime/index.js";
import { loopy, net } from "../src/sdk/index.js";
import { startLoopy } from "../src/sdk/run.js";
import { parseCurl } from "../src/sdk/shell/parse/net.js";
import { fixture, result, SpawnExecutor } from "./shell-parse-fixture.js";

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

async function curlRun(cwd: string, url: string) {
  const store = new MemoryRunStore();

  const output = await startLoopy({
    loopy: loopy({
      name: "curl-parsed",
      run: () => net.curl({ args: [url], flags: { location: true } }),
    }),
    store,
    executor: new SpawnExecutor(),
    cwd,
    runId: "curl-parsed",
    input: {},
    bundleHash: "",
  });

  expect((await store.getSteps("curl-parsed"))[0]).toMatchObject({
    status: "succeeded",
    key: "net.curl",
    output: { status: 200, body: "HTTP/1.1 200 body text\n__LOOPY_CURL__inside" },
  });

  return output;
}

test("real curl against Bun.serve parses redirects and stores the response body intact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopy-curl-parse-"));
  const body = "HTTP/1.1 200 body text\n__LOOPY_CURL__inside";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }

      return new Response(body, { headers: { "X-Loopy": "yes" } });
    },
  });

  try {
    expect(await curlRun(cwd, new URL("/redirect", server.url).href)).toMatchObject({
      status: "succeeded",
      output: {
        status: 200,
        headers: { "x-loopy": "yes" },
        body,
        timeTotal: expect.any(Number),
        sizeDownload: body.length,
        url: new URL("/final", server.url).href,
      },
    });
  } finally {
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});

function compileOnlyChecks() {
  // @ts-expect-error Output redirection removes the body from the parsed stream.
  net.curl({ flags: { output: "body.txt" } });
  net.curl.raw({ flags: { output: "body.txt" } });
  // @ts-expect-error Header-only output removes the response body.
  net.curl({ flags: { head: true } });
  net.curl.raw({ flags: { head: true } });
}

void compileOnlyChecks;

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
