import { assertJson, errorMessage } from "@loopy/core";
import { Effect } from "effect";
import { CliError } from "./errors";

export const parseJsonText = (text: string, label: string) =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(text);
      assertJson(value, label);

      return value;
    },
    catch: (cause) =>
      new CliError({ message: `${label} must be valid JSON: ${errorMessage(cause)}`, cause }),
  });
