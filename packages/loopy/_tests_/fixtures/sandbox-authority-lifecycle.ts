import { rm } from "node:fs/promises";
import type { AttemptDependencies } from "../../../../apps/sandbox/src/attempt-dependencies.js";
import { Attempts } from "../../../../apps/sandbox/src/attempts.js";
import { authorityFixture } from "./sandbox-authority.js";

const roots: string[] = [];

const services: Attempts[] = [];

export async function cleanup() {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function fixture() {
  const value = await authorityFixture();
  roots.push(value.root);

  return value;
}

export async function open(
  config: Awaited<ReturnType<typeof fixture>>["config"],
  dependencies: AttemptDependencies,
) {
  const service = await Attempts.open(config, async () => dependencies);
  services.push(service);

  return service;
}
