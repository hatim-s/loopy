import { resolve } from "node:path";
import { ownerOf } from "../../../sandbox/src/docker/identity";
import { sandboxStateRoot } from "../../../sandbox/src/state-root";
import { root } from "../stack/constants";
import { toolEnvironment } from "../stack/environment";
import { stackPorts } from "../stack/ports";

export const state = resolve(root, ".loopy/cloud-failures");

export const runtime = resolve(state, "runtime-root");

export const sandboxState = sandboxStateRoot(runtime);

export const owner = ownerOf(sandboxState);

export const ports = stackPorts(14970);

export const api = ports.origin("api");

export const sandbox = ports.origin("sandbox");

export const environment = toolEnvironment(state);
