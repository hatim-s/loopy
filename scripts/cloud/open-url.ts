import { resolve } from "node:path";
import { z } from "zod";

const config = z
  .object({
    principals: z.array(z.object({ workspace: z.string(), token: z.string().min(32) })),
  })
  .parse(await Bun.file(resolve(import.meta.dir, "../../.loopy/cloud/local.json")).json());

const principal = config.principals.find(({ workspace }) => workspace === "fixtures");

if (!principal) {
  throw new Error("Start the local cloud fixture stack first.");
}

console.log(`http://127.0.0.1:14872/#token=${encodeURIComponent(principal.token)}`);
