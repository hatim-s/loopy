import type { CommandDescriptor, Input, RawInput } from "../define-command.js";
import type { Ref } from "./ref.js";

type WithRefs<T> = T extends string | number | boolean
  ? T | Ref<T>
  : T extends object
    ? { [K in keyof T]: WithRefs<T[K]> }
    : T;

type Fields<T> = { [K in keyof T]: WithRefs<T[K]> };

export type CommandInput<D extends CommandDescriptor> = Fields<Omit<Input<D>, "flags">> & {
  flags?: Fields<NonNullable<Input<D>["flags"]>>;
};

export type CommandRawInput<D extends CommandDescriptor> = WithRefs<RawInput<D>>;
