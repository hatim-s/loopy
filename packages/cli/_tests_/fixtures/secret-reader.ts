import { Effect, Fiber } from "effect";
import { readSecret } from "../../src/secret-entry";

// Interrupts a secret read at once and prints the stdin state the reader left behind.
const piped = process.argv[2] === "pipe";

await Effect.runPromise(
  Effect.gen(function* () {
    const before = process.stdin.listenerCount("data");
    const rawBefore = process.stdin.isRaw ?? false;
    const fiber = yield* Effect.forkChild(readSecret(piped));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    process.stdout.write(
      JSON.stringify({
        before,
        after: process.stdin.listenerCount("data"),
        paused: process.stdin.isPaused(),
        rawBefore,
        rawAfter: process.stdin.isRaw ?? false,
      }),
    );
  }),
);
