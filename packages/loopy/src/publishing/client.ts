import type { WorkflowVersion } from "../application/ports.js";
import { validateWorkflow } from "../core/workflow.js";
import { type PublishBundle, verifyPublishBundle } from "./manifest.js";

export type HostedPublisherOptions = {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/** A separate machine publishing token is sent only to the explicit HTTPS origin. */
export class HostedPublisher {
  private readonly endpoint: URL;
  constructor(private readonly options: HostedPublisherOptions) {
    const url = new URL(options.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Publishing origin must be an HTTPS origin without credentials or a path");
    if (!options.token || /[\r\n]/.test(options.token))
      throw new Error("A publishing machine token is required");
    this.endpoint = new URL("/versions", url);
  }

  async publish(bundle: PublishBundle): Promise<WorkflowVersion> {
    const verified = await verifyPublishBundle(bundle);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(70_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(verified),
      });
    } catch {
      throw new Error("Hosted publishing request failed");
    }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Hosted publishing failed with HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Hosted publishing returned no version");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        count += item.value.byteLength;
        if (count > 512_000) throw new Error("Hosted publishing response exceeds limits");
        chunks.push(item.value);
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
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== "object")
      throw new Error("Hosted publishing returned an invalid version");
    const version = raw as WorkflowVersion;
    validateWorkflow(version.workflow);
    const publication = version.publication;
    if (
      typeof version.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(version.id) ||
      !Array.isArray(version.files) ||
      version.files.length !== verified.files.length ||
      !verified.files.every((file) =>
        version.files.some(
          (source) =>
            source?.path === file.path &&
            source.artifact?.sha256 === file.sha256 &&
            source.artifact.bytes === file.bytes &&
            source.artifact.id === file.sha256,
        ),
      ) ||
      publication?.bundle?.id !== version.id ||
      publication.bundle.sha256 !== version.id ||
      !Number.isSafeInteger(publication.bundle.bytes) ||
      publication.bundle.bytes < 1 ||
      publication.bundle.bytes > 1_000_000 ||
      JSON.stringify(publication.sourceMappings) !== JSON.stringify(verified.manifest.sources) ||
      !/^[a-f0-9]{64}$/.test(version.graphHash) ||
      version.slug !== version.workflow.slug ||
      version.compiler !== verified.manifest.compiler ||
      version.runtime?.build !== verified.manifest.runtime.build ||
      version.runtime.graphSchema !== 1 ||
      version.entrypoint !== verified.manifest.entrypoint ||
      version.publication?.lockfileHash !== verified.lockfileHash ||
      !/^sha256:[a-f0-9]{64}$/.test(version.imageDigest)
    )
      throw new Error("Hosted publishing returned an invalid version identity");
    return version;
  }
}
