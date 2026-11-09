import type { CommandDescriptor, Input, RawInput } from "../descriptor";
import type { Ref } from "./ref";

type WithRefs<T> = T extends string | number | boolean
  ? T | Ref<T>
  : T extends readonly unknown[]
    ? { [K in keyof T]: WithRefs<T[K]> }
    : T extends object
      ? { [K in keyof T]: WithRefs<T[K]> }
      : T;

type Fields<T> = { [K in keyof T]: WithRefs<T[K]> };

export type CommandInput<D extends CommandDescriptor> = Fields<Omit<Input<D>, "flags">> & {
  flags?: Fields<NonNullable<Input<D>["flags"]>>;
};

export type CommandRawInput<D extends CommandDescriptor> = WithRefs<RawInput<D>>;
