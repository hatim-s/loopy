/** Reads at most `limit` bytes, cancelling the stream and returning null once it exceeds them. */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) {
        return Buffer.concat(chunks);
      }

      size += next.value.byteLength;

      if (size > limit) {
        await reader.cancel();

        return null;
      }

      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
