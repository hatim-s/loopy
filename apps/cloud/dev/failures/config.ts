import { resolve } from "node:path";
import { sha256Hex } from "../shared/hash";
import { root } from "../stack/constants";
import { toolEnvironment } from "../stack/environment";

export const state = resolve(root, ".loopy/cloud-failures");

export const runtime = resolve(state, "runtime-root");

export const sandboxState = resolve(runtime, ".loopy/cloud/sandbox");

export const owner = sha256Hex(sandboxState);

export const ports = { api: 14970, sandbox: 14971, inspector: 14973 } as const;

export const api = `http://127.0.0.1:${ports.api}`;

export const sandbox = `http://127.0.0.1:${ports.sandbox}`;

export const environment = toolEnvironment(state);
