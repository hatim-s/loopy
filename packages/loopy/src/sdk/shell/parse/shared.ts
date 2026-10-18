import type { Json } from "../../../core/index.js";
import { assertJson } from "../../../core/index.js";

export function unexpected(command: string, line: string): never {
  throw new Error(
    `Unexpected ${command} output line: ${line}. Report this with the ${command.split(" ")[0]} version.`,
  );
}

export function lines(stdout: string): string[] {
  return stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
}

export function nulFields(stdout: string, command: string): string[] {
  if (stdout === "") {
    return [];
  }

  if (!stdout.endsWith("\0")) {
    unexpected(command, stdout);
  }

  return stdout.slice(0, -1).split("\0");
}

export function jsonValue(line: string, command: string): Json {
  try {
    const value: unknown = JSON.parse(line);
    assertJson(value);

    return value;
  } catch {
    unexpected(command, line);
  }
}
