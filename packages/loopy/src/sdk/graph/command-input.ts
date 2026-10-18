import type { CommandDescriptor, Input, RawInput } from "../define-command.js";
import type { Ref } from "./ref.js";

type WithRefs<T> = T extends string | number | boolean
  ? T | Ref<T>
  : T extends readonly unknown[]
    ? { [K in keyof T]: WithRefs<T[K]> }
    : T extends object
      ? { [K in keyof T]: WithRefs<T[K]> }
      : T;

type Fields<T> = { [K in keyof T]: WithRefs<T[K]> };

export type CommandInput<D extends Omit<CommandDescriptor, "parse">> = Fields<
  Omit<Input<D>, "flags">
> & {
  flags?: Fields<NonNullable<Input<D>["flags"]>>;
};

export type CommandRawInput<D extends Omit<CommandDescriptor, "parse">> = WithRefs<RawInput<D>>;
