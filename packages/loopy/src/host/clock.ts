export type Clock = {
  now: () => number;
  timeout: (callback: () => void, milliseconds: number) => () => void;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export const SYSTEM_CLOCK: Clock = {
  now: Date.now,
  timeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);

    return () => clearTimeout(timer);
  },
  sleep(milliseconds, signal) {
    return new Promise((resolve) => {
      const finish = () => {
        cancel();
        signal.removeEventListener("abort", finish);
        resolve();
      };

      const cancel = this.timeout(finish, milliseconds);

      if (signal.aborted) {
        finish();
      } else {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  },
};
