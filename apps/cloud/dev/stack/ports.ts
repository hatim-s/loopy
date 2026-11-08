import { createServer } from "node:net";

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
