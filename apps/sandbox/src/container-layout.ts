// Paths shared by the host, both bundled workers and the image built from apps/sandbox/Dockerfile.
export const CONTAINER = {
  input: "/input",
  workspace: "/workspace",
  worker: "/opt/loopy/worker.js",
  artifactWorker: "/opt/loopy/artifact-worker.js",
  request: "request.json",
} as const;

export const containerEnvironment = { HOME: CONTAINER.workspace, TMPDIR: "/tmp" } as const;

export function bundleFile(hash: string) {
  return `${hash}.mjs`;
}
