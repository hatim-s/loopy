export type Clock = {
  now: () => number;
  timeout: (callback: () => void, milliseconds: number) => () => void;
};

export const SYSTEM_CLOCK: Clock = {
  now: Date.now,
  timeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);

    return () => clearTimeout(timer);
  },
};
