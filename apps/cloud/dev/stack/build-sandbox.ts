import { SANDBOX_DOCKER_CONTEXT } from "../../../sandbox/src/docker/identity";
import { root } from "./constants";
import { PROFILE_IMAGES } from "./images";

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
