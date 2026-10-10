import { errorMessage } from "loopy";
import { useMemo, useState } from "react";

export type ErrorReporter = {
  message: string | null;
  report: (cause: unknown) => void;
  clear: () => void;
};

/** One banner for the whole app; the newest failure replaces the previous one. */
export function useErrorReporter(): ErrorReporter {
  const [message, setMessage] = useState<string | null>(null);

  const actions = useMemo(
    () => ({
      report: (cause: unknown) => setMessage(errorMessage(cause)),
      clear: () => setMessage(null),
    }),
    [],
  );

  return { message, ...actions };
}
