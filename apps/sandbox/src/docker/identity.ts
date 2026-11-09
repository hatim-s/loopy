import { createHash } from "node:crypto";

export const SANDBOX_IMAGE = "loopy-sandbox:bun-1.4.0";

// The dedicated Colima profile named in the README. The CLI still requires --docker-context.
export const SANDBOX_DOCKER_CONTEXT = "colima-loopy-cloud-phase1";

export const SANDBOX_LABELS = {
  owner: "loopy.sandbox.owner",
  request: "loopy.sandbox.request",
  role: "loopy.sandbox.role",
} as const;

export type ContainerRole = "artifact";

export function ownerOf(stateRoot: string) {
  return createHash("sha256").update(stateRoot).digest("hex");
}

export function labelArgs(owner: string, requestHash: string, role?: ContainerRole) {
  const labels = [
    `${SANDBOX_LABELS.owner}=${owner}`,
    `${SANDBOX_LABELS.request}=${requestHash}`,
    ...(role ? [`${SANDBOX_LABELS.role}=${role}`] : []),
  ];

  return labels.flatMap((label) => ["--label", label]);
}

export function ownsLabels(
  labels: Record<string, string>,
  owner: string,
  requestHash: string,
  role?: ContainerRole,
) {
  return (
    labels[SANDBOX_LABELS.owner] === owner &&
    labels[SANDBOX_LABELS.request] === requestHash &&
    (role === undefined || labels[SANDBOX_LABELS.role] === role)
  );
}
