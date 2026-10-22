import { readFileSync, writeFileSync } from "node:fs";
import { type Input, root, writeResult } from "./repository.ts";

export default ({
  builds,
  ...input
}: Input & { builds: { client: { bytes: number }; server: { bytes: number } } }) => {
  const client = readFileSync(`${root}/docs/build-client.txt`, "utf8");
  const server = readFileSync(`${root}/docs/build-server.txt`, "utf8");
  writeFileSync(`${root}/docs/build-summary.md`, `# Build summary\n\n${client}\n${server}`);

  return writeResult(
    input,
    "playground-b-parallel-build",
    [builds.client.bytes, builds.server.bytes],
    "Client and server build sizes",
  );
};
