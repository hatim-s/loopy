import type { ModalClient } from "modal";
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
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes =
        typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
      count += bytes.byteLength;
      if (count > limit) throw new Error("Compiler output exceeds limits");
      chunks.push(bytes);
    }
  } finally {
    await reader.cancel().catch(() => {});
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

async function confirmTermination(terminate: () => Promise<void>) {
  try {
    await terminate();
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
    const remaining = () => {
      request.signal.throwIfAborted();
      const timeout = request.policy.deadlineMs - Date.now();
      if (timeout < 1 || timeout > 60_000) throw new Error("Compiler deadline exceeded");
      return timeout;
    };
    remaining();
    const app = await this.options.client.apps.fromName(this.options.appName, {
      createIfMissing: false,
    });
    const image = this.options.client.images.fromRegistry(this.options.image);
    const sandbox = await this.options.client.sandboxes.create(app, image, {
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
    const stop = () => {
      void sandbox.terminate().catch(() => {});
    };
    request.signal.addEventListener("abort", stop, { once: true });
    try {
      request.signal.throwIfAborted();
      const process = await sandbox.exec(["bun", "/opt/loopy/dist/providers/compiler-worker.js"], {
        mode: "text",
        workdir: "/tmp",
        timeoutMs: remaining(),
        secrets: [],
        env: {},
      });
      const output = readBounded(process.stdout, request.policy.maxOutputBytes);
      const errors = readBounded(process.stderr, request.policy.maxOutputBytes);
      const upload = async () => {
        const writer = process.stdin.getWriter();
        try {
          await writer.write(JSON.stringify(bundle));
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      };
      const [, , exitCode] = await Promise.all([output, errors, process.wait(), upload()]);
      request.signal.throwIfAborted();
      if (exitCode !== 0) throw new Error("Isolated compiler exited unsuccessfully");
      const resultProcess = await sandbox.exec(["cat", "/compile-result.json"], {
        mode: "text",
        timeoutMs: remaining(),
        secrets: [],
        env: {},
      });
      const [resultText, , resultCode] = await Promise.all([
        readBounded(resultProcess.stdout, request.policy.maxOutputBytes),
        readBounded(resultProcess.stderr, request.policy.maxOutputBytes),
        resultProcess.wait(),
      ]);
      request.signal.throwIfAborted();
      if (resultCode !== 0) throw new Error("Isolated compiler returned no completed result");
      const raw: unknown = JSON.parse(resultText);
      if (!raw || typeof raw !== "object" || !("workflow" in raw))
        throw new Error("Invalid isolated compiler response");
      return {
        workflow: raw.workflow,
        imageDigest: `sha256:${this.options.image.split("@sha256:")[1]}`,
      };
    } finally {
      request.signal.removeEventListener("abort", stop);
      await confirmTermination(() => sandbox.terminate());
    }
  }
}
