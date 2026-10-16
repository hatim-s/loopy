# Network parser fixtures

curl.darwin.txt was captured on Darwin on 2026-10-17 with system curl 8.7.1
against a disposable Bun.serve bound to 127.0.0.1 on an ephemeral port:

`curl -sS -D - -w '\n__LOOPY_CURL__%{json}' <server-url>`

The server returned `hello\n__LOOPY_CURL__body marker\n` and X-Fixture: yes.
The date, URL, local port and timing metadata are actual output. There is no
Linux capture. Tests also exercise a redirect and a body beginning with HTTP/.

The parser locates the last write-out marker, preserves the body, normalizes
header names to lowercase and joins duplicate values with comma-space. It skips
redirect and informational header blocks, including proxy CONNECT responses.
Parsed curl accepts one URL. Output files, custom write-out/header dumping,
included headers and HEAD requests remain available through .raw.
The -w JSON format requires curl 7.70.0 or newer.
