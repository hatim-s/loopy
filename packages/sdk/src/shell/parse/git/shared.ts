import { unexpected } from "../shared";

export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;

export function required(value: string | undefined, cmd: string, line: string): string {
  if (!value) {
    unexpected(cmd, line);
  }

  return value;
}
