import type { App, AppInfo, ModalClient, Sandbox, SandboxExecParams } from "modal";
import { z } from "zod";
import { type Manifest, type Role, tags } from "./modal-probe-plan.js";
import type { Command, Gateway } from "./modal-probe-run.js";

export const credentialsSchema = z
  .object({
    tokenId: z.string().min(1).max(512),
    tokenSecret: z.string().min(1).max(4096),
  })
  .strict();

type Credentials = z.infer<typeof credentialsSchema>;

const prelude = `import {readFileSync,writeFileSync,openSync,closeSync,renameSync,existsSync} from 'node:fs';
const until=async(test)=>{for(let n=0;n<100;n++){if(test())return;await Bun.sleep(50)}throw Error('fixture-timeout')};\n`;

export const commands: Record<Command, string> = {
  writer: `${prelude}writeFileSync('/tmp/loopy-a','a');await until(()=>existsSync('/tmp/loopy-b'));if(readFileSync('/tmp/loopy-b','utf8')!=='b')throw Error('bad-b');process.stdout.write('shared-ok');`,
  reader: `${prelude}await until(()=>existsSync('/tmp/loopy-a'));if(readFileSync('/tmp/loopy-a','utf8')!=='a')throw Error('bad-a');writeFileSync('/tmp/loopy-b','b');process.stdout.write('shared-ok');`,
  effect: `${prelude}const fd=openSync('/tmp/loopy-effect','wx');writeFileSync(fd,'once\\n');closeSync(fd);await Bun.sleep(1000);writeFileSync('/tmp/loopy-result.part',JSON.stringify({effect:'once',result:'ok'}));renameSync('/tmp/loopy-result.part','/tmp/loopy-result');`,
  recover: `${prelude}await until(()=>existsSync('/tmp/loopy-result'));const result=JSON.parse(readFileSync('/tmp/loopy-result','utf8'));if(readFileSync('/tmp/loopy-effect','utf8')!=='once\\n'||JSON.stringify(result)!==JSON.stringify({effect:'once',result:'ok'}))throw Error('bad-recovery');process.stdout.write('recovered-once');`,
};

export function payload(manifest: Manifest, role: Role) {
  const spec = manifest.sandboxes.find((sandbox) => sandbox.role === role);

  if (!spec) {
    throw new Error("sandbox-role-missing");
  }

  return {
    ...manifest.resources,
    name: spec.name,
    tags: tags(manifest, role),
    timeoutMs: spec.timeoutMs,
    command: ["bun", "-e", "await Bun.sleep(300000)"],
  };
}

export async function boundedText(stream: ReadableStream<string>, limit: number): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  let bytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        return output;
      }

      bytes += Buffer.byteLength(chunk.value);

      if (bytes > limit) {
        await reader.cancel();
        throw new Error("process-output-limit");
      }

      output += chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface SdkApp {
  appId: string;
  info(params: Parameters<App["info"]>[0]): Promise<Pick<AppInfo, "functions" | "servers">>;
}

interface SdkSandbox
  extends Pick<Sandbox, "sandboxId" | "getTags" | "detach" | "poll" | "terminate"> {
  exec(
    command: string[],
    params: SandboxExecParams & { mode: "text" },
  ): Promise<{
    stdout: ReadableStream<string>;
    wait(): Promise<number>;
  }>;
}

export interface ProbeSdk<A extends SdkApp, I, S extends SdkSandbox> {
  apps: { fromName(...args: Parameters<ModalClient["apps"]["fromName"]>): Promise<A> };
  images: { fromRegistry(...args: Parameters<ModalClient["images"]["fromRegistry"]>): I };
  sandboxes: {
    experimentalList(
      ...args: Parameters<ModalClient["sandboxes"]["experimentalList"]>
    ): AsyncIterable<Pick<Sandbox, "sandboxId">>;
    create(app: A, image: I, params: Parameters<ModalClient["sandboxes"]["create"]>[2]): Promise<S>;
    fromName(...args: Parameters<ModalClient["sandboxes"]["fromName"]>): Promise<S>;
    fromId(id: string): Promise<S>;
  };
  close(): void;
}

export class ModalGateway<A extends SdkApp, I, S extends SdkSandbox> implements Gateway {
  private readonly handles = new Map<string, S>();
  private appReference?: A;
  constructor(
    private readonly client: ProbeSdk<A, I, S>,
    private readonly manifest: Manifest,
    private readonly notFound: (cause: unknown) => boolean,
  ) {}

  private async appHandle(createIfMissing = false) {
    return this.client.apps.fromName(this.manifest.appName, {
      environment: this.manifest.target.environment,
      createIfMissing,
    });
  }

  async app() {
    let app: A;

    try {
      app = await this.appHandle();
    } catch (error) {
      if (this.notFound(error)) {
        return null;
      }

      throw error;
    }

    const info = await app.info({ refresh: true });
    let populated = Object.keys(info.functions).length + Object.keys(info.servers).length > 0;

    for await (const sandbox of this.client.sandboxes.experimentalList({
      appId: app.appId,
      environment: this.manifest.target.environment,
    })) {
      populated = Boolean(sandbox.sandboxId);
      break;
    }

    this.appReference = app;

    return { id: app.appId, populated };
  }

  async createApp() {
    this.appReference = await this.appHandle(true);

    return this.appReference.appId;
  }

  async create(role: Role) {
    const app = this.appReference;

    if (!app) {
      throw new Error("app-not-verified");
    }

    const image = this.client.images.fromRegistry(this.manifest.image);
    const sandbox = await this.client.sandboxes.create(app, image, payload(this.manifest, role));
    this.handles.set(sandbox.sandboxId, sandbox);

    return sandbox.sandboxId;
  }

  async lookup(role: Role) {
    const spec = this.manifest.sandboxes.find((sandbox) => sandbox.role === role);

    if (!spec) {
      throw new Error("sandbox-role-missing");
    }

    let sandbox: S;

    try {
      // In 0.11.1 includeTerminated forces V2 lookup even with V1 selected.
      sandbox = await this.client.sandboxes.fromName(this.manifest.appName, spec.name, {
        environment: this.manifest.target.environment,
      });
    } catch (error) {
      if (this.notFound(error)) {
        return null;
      }

      throw error;
    }

    this.handles.set(sandbox.sandboxId, sandbox);

    return { id: sandbox.sandboxId, tags: await sandbox.getTags() };
  }

  private async sandbox(id: string) {
    let sandbox = this.handles.get(id);

    if (!sandbox) {
      sandbox = await this.client.sandboxes.fromId(id);
      this.handles.set(id, sandbox);
    }

    return sandbox;
  }

  async byId(id: string) {
    return { id, tags: await (await this.sandbox(id)).getTags() };
  }

  async start(id: string, command: Command) {
    const process = await (await this.sandbox(id)).exec(["bun", "-e", commands[command]], {
      mode: "text",
      timeoutMs: this.manifest.bounds.processTimeoutMs,
      stdout: command === "effect" ? "ignore" : "pipe",
      stderr: "ignore",
    });

    return {
      result: async () => {
        const [output, code] = await Promise.all([
          boundedText(process.stdout, this.manifest.bounds.outputBytes),
          process.wait(),
        ]);

        if (code !== 0) {
          throw new Error("fixture-process-failed");
        }

        return output;
      },
    };
  }

  async poll(id: string) {
    return (await this.sandbox(id)).poll();
  }
  async terminate(id: string) {
    await (await this.sandbox(id)).terminate();
  }
  close() {
    for (const sandbox of this.handles.values()) {
      sandbox.detach();
    }

    this.client.close();
  }
}

export async function connectModal(manifest: Manifest, credentials: Credentials): Promise<Gateway> {
  // Only the sanitized, approved worker calls this function. Import itself reads Modal config.
  const { ModalClient, NotFoundError } = await import("modal");

  const client = new ModalClient({
    ...credentials,
    environment: manifest.target.environment,
    maxThrottleWaitSecs: 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  if (client.version() !== "0.11.1") {
    client.close();
    throw new Error("modal-sdk-version-mismatch");
  }

  try {
    await client.environments.fromName(manifest.target.environment, { createIfMissing: false });

    return new ModalGateway(client, manifest, (error) => error instanceof NotFoundError);
  } catch (error) {
    client.close();
    throw error;
  }
}
