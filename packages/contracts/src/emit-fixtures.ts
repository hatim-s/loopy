import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitPublicJsonSchemas } from "./json-schema.js";

const output = join(import.meta.dir, "../../../fixtures/workflows/schema-snapshots.json");
mkdirSync(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify(emitPublicJsonSchemas(), null, 2)}\n`);
