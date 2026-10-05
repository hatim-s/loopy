import type {
  ArtifactIdentity,
  ArtifactStore,
  RuntimeIdentity,
  WorkflowCatalog,
  WorkflowVersion,
} from "../application/ports.js";
import type { Workflow } from "../core/model.js";
import { validateWorkflow } from "../core/workflow.js";
import {
  hashContent,
  normalizeBundlePath,
  type PublishBundle,
  verifyPublishBundle,
} from "./manifest.js";

export type CompileRequest = {
  readonly bundle: PublishBundle;
  readonly signal: AbortSignal;
  readonly policy: {
    readonly deadlineMs: number;
    readonly maxOutputBytes: number;
    readonly serviceCredentials: false;
    readonly dependencies: "locked-only";
  };
};
export type CompileResult = { readonly workflow: unknown; readonly imageDigest: string };
/** Implementations run authoring code in a separate sandbox with no service credentials. */
export interface IsolatedCompiler {
  compile(request: CompileRequest): Promise<CompileResult>;
}
export type PublishingPorts = {
  readonly artifacts: ArtifactStore;
  readonly catalog: WorkflowCatalog;
  readonly compiler?: IsolatedCompiler;
  readonly expected: {
    readonly compiler: string;
    readonly runtime: RuntimeIdentity;
    readonly imageDigest: string;
  };
};

function mapFiles(workflow: Workflow, bundle: PublishBundle): Workflow {
  const mappings = new Map(bundle.manifest.sources.map(({ source, target }) => [source, target]));
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (typeof object.$file === "string") {
      const source = normalizeBundlePath(object.$file);
      const target = mappings.get(source);
      if (!target) throw new Error(`Undeclared workflow file reference: ${source}`);
      return { $file: target };
    }
    if (object.kind === "command") {
      const command = object.command as Record<string, unknown>;
      if (typeof command.cwd === "string" && command.cwd !== ".") {
        normalizeBundlePath(command.cwd);
        if (mappings.size > 0)
          throw new Error(
            "Portable source mappings require commands to use the workspace root cwd",
          );
      }
      if (
        typeof command.program === "string" &&
        (command.program.startsWith("/") ||
          command.program.includes("\\") ||
          command.program.includes(":"))
      )
        throw new Error("Workflow program must be portable");
      if (typeof command.program === "string" && command.program.includes("/")) {
        const source = normalizeBundlePath(command.program);
        const target = mappings.get(source);
        if (!target) throw new Error(`Undeclared workflow program: ${source}`);
        return { ...object, command: visit({ ...command, program: `./${target}` }) };
      }
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
  }
  return visit(workflow) as Workflow;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export class PublishingService {
  constructor(private readonly ports: PublishingPorts) {}

  async publish(bundle: PublishBundle): Promise<WorkflowVersion> {
    const { compiler, artifacts, catalog } = this.ports;
    if (!compiler)
      throw new Error("Isolated compiler is not configured. No version was published.");
    if (artifacts.scope.tenantId !== catalog.scope.tenantId)
      throw new Error("Publishing stores must use the same tenant");
    const verified = await verifyPublishBundle(bundle);
    const expected = this.ports.expected;
    if (
      verified.manifest.compiler !== expected.compiler ||
      verified.manifest.runtime.build !== expected.runtime.build ||
      verified.manifest.runtime.graphSchema !== expected.runtime.graphSchema
    )
      throw new Error("Bundle compiler or runtime identity is unsupported");
    if (!/^sha256:[a-f0-9]{64}$/.test(expected.imageDigest))
      throw new Error("Publishing requires a host-selected pinned image digest");
    const maxOutputBytes = 100_000;
    const deadlineMs = Date.now() + 60_000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error("Compiler deadline exceeded"));
        },
        Math.max(0, deadlineMs - Date.now()),
      );
    });
    let result: CompileResult;
    try {
      result = await Promise.race([
        compiler.compile({
          bundle: verified,
          signal: controller.signal,
          policy: {
            deadlineMs,
            maxOutputBytes,
            serviceCredentials: false,
            dependencies: "locked-only",
          },
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() > deadlineMs) throw new Error("Compiler deadline exceeded");
    if (result.imageDigest !== expected.imageDigest)
      throw new Error("Compiler image digest does not match the configured image");
    validateWorkflow(result.workflow);
    const graphBytes = new TextEncoder().encode(JSON.stringify(result.workflow));
    if (graphBytes.byteLength > maxOutputBytes) throw new Error("Compiler output exceeds limits");
    const graph: unknown = JSON.parse(new TextDecoder().decode(graphBytes));
    validateWorkflow(graph);
    const workflow = mapFiles(graph, verified);
    const graphHash = await hashContent(
      new TextEncoder().encode(JSON.stringify(canonical(workflow))),
    );
    async function put(bytes: Uint8Array): Promise<ArtifactIdentity> {
      const identity = await artifacts.put(bytes);
      if (
        !identity.id ||
        identity.bytes !== bytes.byteLength ||
        identity.sha256 !== (await hashContent(bytes))
      )
        throw new Error("Artifact store returned an invalid content identity");
      return identity;
    }
    const compiled = { bundle: verified, workflow, graphHash, imageDigest: result.imageDigest };
    const compiledBytes = new TextEncoder().encode(JSON.stringify(compiled));
    if (compiledBytes.byteLength > 1_000_000)
      throw new Error("Compiled publication artifact exceeds pilot storage limits");
    const bundleIdentity = {
      id: await hashContent(compiledBytes),
      sha256: await hashContent(compiledBytes),
      bytes: compiledBytes.byteLength,
    };
    const files = verified.files.map((file) => ({
      path: file.path,
      artifact: { id: file.sha256, sha256: file.sha256, bytes: file.bytes },
    }));
    const version: WorkflowVersion = {
      id: bundleIdentity.sha256,
      slug: workflow.slug,
      workflow,
      graphHash,
      files,
      entrypoint: verified.manifest.entrypoint,
      compiler: verified.manifest.compiler,
      runtime: verified.manifest.runtime,
      imageDigest: result.imageDigest,
      publication: {
        bundle: bundleIdentity,
        lockfileHash: verified.lockfileHash,
        sourceMappings: verified.manifest.sources,
      },
    };
    if (new TextEncoder().encode(JSON.stringify(version)).byteLength > 512_000)
      throw new Error("Published version exceeds pilot storage limits");
    for (const file of verified.files) {
      const identity = await put(new TextEncoder().encode(file.content));
      if (identity.id !== file.sha256)
        throw new Error("Pilot publishing requires content-addressed artifact identifiers");
    }
    const persisted = await put(compiledBytes);
    if (persisted.id !== bundleIdentity.id)
      throw new Error("Pilot publishing requires content-addressed artifact identifiers");
    return catalog.publish(version);
  }
}
