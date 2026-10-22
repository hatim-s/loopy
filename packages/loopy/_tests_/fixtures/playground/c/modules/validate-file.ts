import { digest, readSource } from "./repository.js";

export default async function validateFile({ file }: { file: string }) {
  const content = await readSource(file);

  if (content.length === 0 || content.length > 4096) {
    throw new Error("PLAYGROUND_SOURCE_INVALID: source file must contain 1 to 4096 characters.");
  }

  console.log(`Validated ${file}: ${content.length} characters.`);

  return { file, bytes: Buffer.byteLength(content), hash: digest(content) };
}
