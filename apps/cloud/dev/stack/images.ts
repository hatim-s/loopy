import { SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";

export const PROFILE_NAMES = ["architecture"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Every profile label a stack identity or diagnostic approval may record. */
export const PROFILE_LABELS = ["default", ...PROFILE_NAMES] as const;

/** A named profile runs its own tag of the one sandbox image, built by cloud:build-sandbox. */
export function profileImage(name: ProfileName | undefined) {
  return name === undefined ? SANDBOX_IMAGE : `${SANDBOX_IMAGE}-${name}`;
}

export const PROFILE_IMAGES = [profileImage(undefined), ...PROFILE_NAMES.map(profileImage)];
