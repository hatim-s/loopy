import type { CommandResult } from "../../../core/index.js";
import { jsonValue, unexpected } from "./shared.js";

export type Curl = {
  status: number;
  headers: Record<string, string>;
  body: string;
  timeTotal: number;
  sizeDownload: number;
  url: string;
};

export const CURL_WRITE_OUT = "\n__LOOPY_CURL__%{json}";

const CURL_MARKER = "\n__LOOPY_CURL__";

function headerBlock(block: string) {
  const [first = "", ...rows] = block.split(/\r?\n/);
  const match = /^HTTP\/\S+ (\d{3})(?: .*)?$/.exec(first);

  if (!match) {
    unexpected("curl", first);
  }

  const headers: Record<string, string> = {};

  for (const line of rows) {
    const field = /^([^:\s]+):[ \t]*(.*)$/.exec(line);

    if (!field?.[1] || field[2] === undefined) {
      unexpected("curl", line);
    }

    const name = field[1].toLowerCase();
    Object.defineProperty(headers, name, {
      value: Object.hasOwn(headers, name) ? `${headers[name]}, ${field[2]}` : field[2],
      enumerable: true,
      configurable: true,
    });
  }

  return { status: Number(match[1]), proxy: /connection established$/i.test(first), headers };
}

function responseBody(stdout: string, status: number, redirects: number) {
  let rest = stdout;
  let remaining = redirects;

  while (rest.startsWith("HTTP/")) {
    const separator = /\r?\n\r?\n/.exec(rest);

    if (!separator || separator.index === undefined) {
      unexpected("curl", rest);
    }

    const block = headerBlock(rest.slice(0, separator.index));
    rest = rest.slice(separator.index + separator[0].length);

    if (block.status >= 300 && block.status < 400 && remaining > 0) {
      remaining--;
      continue;
    }

    // Informational responses and proxy CONNECT precede the final response headers.
    if (block.status === status && !block.proxy && !(block.status >= 100 && block.status < 200)) {
      return { headers: block.headers, body: rest };
    }
  }

  return unexpected("curl", rest);
}

// BOUNDARY: curl metadata is untrusted JSON; require the fields used in the typed result.
export function parseCurl({ stdout }: CommandResult): Curl {
  const marker = stdout.lastIndexOf(CURL_MARKER);

  if (marker === -1) {
    unexpected("curl", stdout);
  }

  const line = stdout.slice(marker + CURL_MARKER.length);
  const info = jsonValue(line, "curl");

  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    typeof info.http_code !== "number" ||
    !Number.isInteger(info.http_code) ||
    typeof info.time_total !== "number" ||
    info.time_total < 0 ||
    typeof info.size_download !== "number" ||
    info.size_download < 0 ||
    typeof info.num_redirects !== "number" ||
    !Number.isSafeInteger(info.num_redirects) ||
    info.num_redirects < 0 ||
    typeof info.url_effective !== "string"
  ) {
    unexpected("curl", line);
  }

  return {
    status: info.http_code,
    ...responseBody(stdout.slice(0, marker), info.http_code, info.num_redirects),
    timeTotal: info.time_total,
    sizeDownload: info.size_download,
    url: info.url_effective,
  };
}
