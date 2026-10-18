import type { CommandDescriptor, Input, RawInput } from "../define-command.js";
import type { Ref } from "./ref.js";

type WithRefs<T> = [T] extends [undefined]
  ? T
  : [Exclude<T, undefined>] extends [string | number | boolean]
    ? T | Ref<Exclude<T, undefined>>
    : T extends object
      ? { [K in keyof T]: WithRefs<T[K]> }
      : T;

type Fields<T> = { [K in keyof T]: WithRefs<T[K]> };

export type CommandInput<D extends CommandDescriptor> = Fields<Omit<Input<D>, "flags">> & {
  flags?: Fields<NonNullable<Input<D>["flags"]>>;
};

export type CommandRawInput<D extends CommandDescriptor> = Fields<Omit<RawInput<D>, "flags">> & {
  flags?: Fields<NonNullable<RawInput<D>["flags"]>>;
};
