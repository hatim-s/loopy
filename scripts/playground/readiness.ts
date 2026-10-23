import { z } from "zod";

const healthSchema = z.object({ service: z.literal("loopy-cloud"), stage: z.literal("local") });

type HealthRequest = (url: string, init: RequestInit) => Promise<Response>;

export async function waitForWorker(
  url: string,
  child: Pick<ReturnType<typeof Bun.spawn>, "exitCode">,
  request: HealthRequest = fetch,
) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Owned Worker exited before receipt authority health became ready.");
    }

    const ready = await request(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      .then(async (response) => {
        const health: unknown = await response.json();

        return response.ok && healthSchema.safeParse(health).success;
      })
      .catch(() => false);

    if (ready) {
      return;
    }

    await Bun.sleep(200);
  }

  throw new Error(
    "Owned Worker health did not become ready within fifteen seconds. Sandbox was not started.",
  );
}
