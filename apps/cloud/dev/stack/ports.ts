import { createServer } from "node:net";

/** Every local stack puts its services on four consecutive ports after the API. */
export function stackPorts(api: number) {
  const ports = { api, sandbox: api + 1, dashboard: api + 2, inspector: api + 3 };

  return {
    ...ports,
    list: Object.values(ports),
    origin: (service: "api" | "sandbox" | "dashboard") => `http://127.0.0.1:${ports[service]}`,
  };
}

// apps/cloud/wrangler.jsonc pins the Worker, sandbox URL and inspector to these ports.
export const LOCAL_STACK = stackPorts(14870);

// An occupied port belongs to someone else, so the stack refuses to start instead of stopping it.
export async function requireFreePorts(ports: readonly number[]) {
  for (const port of ports) {
    await new Promise<void>((done, reject) => {
      const listener = createServer();
      listener.once("error", () =>
        reject(
          new Error(
            `Port ${port} is occupied. Preserve its owner and choose another local configuration.`,
          ),
        ),
      );
      listener.listen(port, "127.0.0.1", () => listener.close(() => done()));
    });
  }
}
