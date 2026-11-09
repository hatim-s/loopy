import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../../../..");

// The sandbox README names this Colima profile; the image is built by `bun run cloud:build-sandbox`.
export const DOCKER_CONTEXT = "colima-loopy-cloud-phase1";

export const SANDBOX_IMAGE = "loopy-sandbox:bun-1.4.0";
