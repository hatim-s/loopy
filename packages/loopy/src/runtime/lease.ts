export const OWNERSHIP_LOST = "Run ownership lost.";

/**
 * Keeps the run's owner token fresh with single-flight heartbeats. Losing
 * ownership aborts the shared controller so a launched command stops too.
 */
export class Lease {
  private inFlight?: Promise<boolean>;
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;
  error?: unknown;

  constructor(
    private readonly beat: () => Promise<boolean>,
    private readonly controller: AbortController,
    intervalMs: number,
  ) {
    this.timer = setInterval(() => void this.pulse(), intervalMs);
  }

  get lost(): boolean {
    return this.failed;
  }

  pulse(): Promise<boolean> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = Promise.resolve()
      .then(this.beat)
      .then((owned) => {
        if (!owned) {
          this.fail(new Error(OWNERSHIP_LOST));
        }
        return owned;
      })
      .catch((error: unknown) => {
        this.fail(error);
        return false;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private fail(error: unknown): void {
    this.failed = true;
    this.error = error;
    this.controller.abort(error);
  }

  /** Stops the timer and drains any heartbeat still in flight. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      await this.inFlight;
    }
  }
}
