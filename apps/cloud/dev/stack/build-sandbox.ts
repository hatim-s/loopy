import { SANDBOX_DOCKER_CONTEXT } from "../../../sandbox/src/docker/identity";
import { PROFILE_IMAGES } from "../playground/profile";
import { root } from "./constants";

const build = Bun.spawn(
  [
    "docker",
    "--context",
    SANDBOX_DOCKER_CONTEXT,
    "build",
    "-f",
    "apps/sandbox/Dockerfile",
    ...PROFILE_IMAGES.flatMap((image) => ["-t", image]),
    ".",
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);

process.exit(await build.exited);
