import { resolve } from "node:path";
import { playgroundProfile } from "../playground/profile";
import { root } from "../stack/constants";

const profile = playgroundProfile(root, process.env.LOOPY_PLAYGROUND_PROFILE);

export const state = resolve(
  root,
  `.loopy/playground-daemon${profile.name ? `-${profile.name}` : ""}`,
);

export const home = resolve(state, "home");

export const source = resolve(state, "loopies-playground");

export const upstream = profile.repository;

export const evidence = profile.evidence;

export const port = profile.name ? 15370 : 15170;

export function environment() {
  return {
    ...profile.environment,
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    HOME: resolve(state, "process-home"),
    LOOPY_HOME: home,
  };
}

export function evidencePath(name: string) {
  return resolve(evidence, `playground-daemon${name}.json`);
}

export async function writeEvidence<T>(name: string, value: T) {
  await Bun.write(evidencePath(name), `${JSON.stringify(value, null, 2)}\n`);
}
