import type { ModalClient } from "modal";
import { abortable } from "../publishing/abort.js";
import { verifyPublishBundle } from "../publishing/manifest.js";
import type { CompileRequest, CompileResult, IsolatedCompiler } from "../publishing/service.js";

export type ModalCompilerOptions = {
  readonly client: Pick<ModalClient, "apps" | "images" | "sandboxes">;
  readonly appName: string;
  readonly image: string;
};

async function readBounded(
  stream: ReadableStream<string | Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      const bytes =
        typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
      count += bytes.byteLength;
      if (count > limit) throw new Error("Compiler output exceeds limits");
      chunks.push(bytes);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function confirmTermination(terminate: () => Promise<number>) {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        terminate(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Termination confirmation deadline exceeded")),
            5_000,
          );
        }),
      ]);
      if (!Number.isInteger(exitCode))
        throw new Error("Termination returned no confirmed exit code");
    } finally {
      clearTimeout(timer);
    }
  } catch (cause) {
    throw new Error("Compiler sandbox termination could not be confirmed", { cause });
  }
}

/** Each compilation uses a fresh pinned image with no injected secrets, mounts or network. */
export class ModalIsolatedCompiler implements IsolatedCompiler {
  constructor(private readonly options: ModalCompilerOptions) {
    if (!options.appName || !/^.+@sha256:[a-f0-9]{64}$/.test(options.image))
      throw new Error("Compiler requires an existing app and digest-pinned image");
  }
  async compile(request: CompileRequest): Promise<CompileResult> {
    request.signal.throwIfAborted();
    const bundle = await verifyPublishBundle(request.bundle);
    if (
      request.policy.serviceCredentials !== false ||
      request.policy.dependencies !== "locked-only" ||
      !Number.isSafeInteger(request.policy.maxOutputBytes) ||
      request.policy.maxOutputBytes < 1 ||
      request.policy.maxOutputBytes > 100_000
    )
      throw new Error("Unsupported isolated compiler policy");
    const initialRemaining = request.policy.deadlineMs - Date.now();
    if (
      !Number.isSafeInteger(initialRemaining) ||
      initialRemaining < 1 ||
      initialRemaining > 60_000
    )
      throw new Error("Compiler deadline exceeded");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(initialRemaining)]);
    const remaining = () => {
      signal.throwIfAborted();
      const timeout = request.policy.deadlineMs - Date.now();
      if (timeout < 1 || timeout > 60_000) throw new Error("Compiler deadline exceeded");
      const vendorTimeout = Math.floor(timeout / 1_000) * 1_000;
      if (vendorTimeout < 1_000)
        throw new Error("Compiler deadline has less than one SDK timeout second remaining");
      return vendorTimeout;
    };
    remaining();
    const app = await abortable(
      this.options.client.apps.fromName(this.options.appName, {
        createIfMissing: false,
      }),
      signal,
    );
    const image = this.options.client.images.fromRegistry(this.options.image);
    const creation = this.options.client.sandboxes.create(app, image, {
      timeoutMs: remaining(),
      cpu: 1,
      cpuLimit: 1,
      memoryMiB: 512,
      memoryLimitMiB: 512,
      blockNetwork: true,
      secrets: [],
      volumes: {},
      env: {},
      command: ["sleep", "60"],
    });
    let claimed = false;
    void creation
      .then((lateSandbox) => {
        if (signal.aborted && !claimed)
          return confirmTermination(() => lateSandbox.terminate({ wait: true }));
      })
      .catch(() => {});
    const sandbox = await abortable(creation, signal);
    claimed = true;
    let termination: Promise<void> | undefined;
    const stop = () => {
      termination ??= confirmTermination(() => sandbox.terminate({ wait: true }));
      void termination.catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    let result: CompileResult;
    try {
      signal.throwIfAborted();
      const process = await abortable(
        sandbox.exec(["bun", "/opt/loopy/dist/providers/compiler-worker.js"], {
          mode: "text",
          workdir: "/tmp",
          timeoutMs: remaining(),
          secrets: [],
          env: {},
        }),
        signal,
      );
      const output = readBounded(process.stdout, request.policy.maxOutputBytes, signal);
      const errors = readBounded(process.stderr, request.policy.maxOutputBytes, signal);
      const upload = async () => {
        const writer = process.stdin.getWriter();
        try {
          await abortable(writer.write(JSON.stringify(bundle)), signal);
          await abortable(writer.close(), signal);
        } finally {
          writer.releaseLock();
        }
      };
      const [, , exitCode] = await Promise.all([
        output,
        errors,
        abortable(process.wait(), signal),
        upload(),
      ]);
      signal.throwIfAborted();
      if (exitCode !== 0) throw new Error("Isolated compiler exited unsuccessfully");
      const resultProcess = await abortable(
        sandbox.exec(["cat", "/compile-result.json"], {
          mode: "text",
          timeoutMs: remaining(),
          secrets: [],
          env: {},
        }),
        signal,
      );
      const [resultText, , resultCode] = await Promise.all([
        readBounded(resultProcess.stdout, request.policy.maxOutputBytes, signal),
        readBounded(resultProcess.stderr, request.policy.maxOutputBytes, signal),
        abortable(resultProcess.wait(), signal),
      ]);
      signal.throwIfAborted();
      if (resultCode !== 0) throw new Error("Isolated compiler returned no completed result");
      const raw: unknown = JSON.parse(resultText);
      if (!raw || typeof raw !== "object" || !("workflow" in raw))
        throw new Error("Invalid isolated compiler response");
      result = {
        workflow: raw.workflow,
        imageDigest: `sha256:${this.options.image.split("@sha256:")[1]}`,
      };
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await termination;
    }
    signal.throwIfAborted();
    if (Date.now() >= request.policy.deadlineMs)
      throw new Error("Compiler deadline exceeded during cleanup");
    return result;
  }
}
