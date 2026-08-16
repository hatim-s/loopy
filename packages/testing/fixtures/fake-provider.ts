#!/usr/bin/env bun

/** Small deterministic executable used by provider conformance tests. */
const args = Bun.argv.slice(2);

if (args.includes("--version")) {
  console.log("fake-provider 1.2.3");
} else if (args.includes("--probe")) {
  console.log(
    JSON.stringify({
      provider: "fake",
      version: "1.2.3",
      capabilities: { structuredStreamingEvents: true },
    }),
  );
} else if (args.includes("--malformed")) {
  console.log("not-json");
} else if (args.includes("--stderr")) {
  console.error("fake-provider diagnostic");
} else if (args.includes("--hang")) {
  setTimeout(() => undefined, 60_000);
} else {
  console.log(JSON.stringify({ type: "message", text: "fixture" }));
}
