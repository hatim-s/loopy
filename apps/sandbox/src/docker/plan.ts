import { type DockerAttemptPlan, inputHelperName } from "@loopy/contract/sandbox";
import type { SandboxConfig } from "../config";
import { CONTAINER, containerEnvironment } from "../container-layout";

const hardened = [
  "--network",
  "none",
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--read-only",
];

function create(name: string, labels: string[]) {
  return ["create", "--name", name, ...labels, ...hardened];
}

export function inputContainerArgs(
  config: SandboxConfig,
  plan: DockerAttemptPlan,
  labels: string[],
) {
  return [
    ...create(inputHelperName(plan), labels),
    "--mount",
    `type=volume,source=${plan.inputVolume},target=${CONTAINER.input}`,
    config.image,
  ];
}

export function attemptContainerArgs(
  config: SandboxConfig,
  plan: DockerAttemptPlan,
  labels: string[],
) {
  return [
    ...create(plan.container, labels),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--memory",
    config.memory,
    "--memory-swap",
    config.memory,
    "--cpus",
    String(config.cpus),
    "--pids-limit",
    String(config.pids),
    "--ulimit",
    "nofile=256:256",
    "--init",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=4m",
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
    "--mount",
    `type=volume,source=${plan.volume},target=${CONTAINER.workspace}`,
    "--mount",
    `type=volume,source=${plan.inputVolume},target=${CONTAINER.input},readonly`,
    "--workdir",
    CONTAINER.workspace,
    ...Object.entries(containerEnvironment).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--entrypoint",
    "bun",
    config.image,
    CONTAINER.worker,
  ];
}

export function artifactContainerArgs(
  config: SandboxConfig,
  plan: DockerAttemptPlan,
  name: string,
  labels: string[],
  path: string,
) {
  return [
    ...create(name, labels),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "0.5",
    "--pids-limit",
    "32",
    "--ulimit",
    "nofile=128:128",
    "--init",
    "--log-driver",
    "none",
    "--mount",
    `type=volume,source=${plan.volume},target=${CONTAINER.workspace},readonly,volume-nocopy`,
    "--workdir",
    CONTAINER.workspace,
    "--entrypoint",
    "bun",
    config.image,
    CONTAINER.artifactWorker,
    path,
  ];
}
