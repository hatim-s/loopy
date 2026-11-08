import { SANDBOX_DOCKER_CONTEXT, SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";
import { root } from "./constants";

const build = Bun.spawn(
  [
    "docker",
    "--context",
    SANDBOX_DOCKER_CONTEXT,
    "build",
    "-f",
    "apps/sandbox/Dockerfile",
    "-t",
    SANDBOX_IMAGE,
    ".",
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);

process.exit(await build.exited);
