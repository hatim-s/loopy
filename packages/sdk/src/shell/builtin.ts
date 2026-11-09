import type { OutSchema, ParserInput } from "@loopy/core";
import type { CommandDeclaration, Prepare } from "../descriptor";
import {
  type CallMode,
  type CommandCall,
  commandCall,
  commandOutput,
} from "../graph/nodes/command";
import type { Infer } from "../graph/types";

export type Parser<R> = (result: ParserInput) => R;

/** Most built-ins take any number of file operands. */
export const PATHS = [{ name: "paths", optional: true, variadic: true }] as const;

/** A symbol key keeps host metadata off the author call surface the compiler enumerates. */
export const BUILTIN = Symbol("loopy.command.builtin");

export type Hosted = { readonly [BUILTIN]: { key: string; parse: Parser<unknown> | null } };

/** A built-in waits for its namespace to name it, so its node key always equals its call path. */
export class Builtin<C> {
  constructor(readonly create: (key: string) => C) {}
}

export function builtin<const D extends CommandDeclaration>(
  descriptor: D,
): Builtin<CommandCall<D, typeof commandOutput> & Hosted>;
export function builtin<
  const D extends CommandDeclaration,
  const S extends OutSchema,
  const R extends CommandDeclaration = D,
>(
  descriptor: D,
  parsed: { parse: Parser<Infer<S>>; out: S; prepare?: Prepare; raw?: R },
): Builtin<CommandCall<D, S, R> & Hosted>;
export function builtin<
  D extends CommandDeclaration,
  S extends OutSchema,
  R extends CommandDeclaration,
>(descriptor: D, parsed?: { parse: Parser<Infer<S>>; out: S; prepare?: Prepare; raw?: R }) {
  const mode: CallMode = parsed
    ? { out: parsed.out, prepare: parsed.prepare, parser: { module: null } }
    : { out: commandOutput, parser: null };

  return new Builtin((key) =>
    Object.assign(commandCall(key, descriptor, mode, parsed?.raw ?? descriptor), {
      [BUILTIN]: { key, parse: parsed?.parse ?? null },
    }),
  );
}

type Table = { readonly [name: string]: Builtin<unknown> | Table };

type Commands<T extends Table> = {
  readonly [K in keyof T]: T[K] extends Builtin<infer C>
    ? C
    : T[K] extends Table
      ? Commands<T[K]>
      : never;
};

export function namespace<const T extends Table>(prefix: string, table: T): Commands<T> {
  const entries = Object.entries(table).map(([name, entry]) => {
    const key = `${prefix}.${name}`;

    return [name, entry instanceof Builtin ? entry.create(key) : namespace(key, entry)] as const;
  });

  // SAFETY: Each entry keeps its name and becomes its own call or nested table, as Commands<T> maps.
  return Object.fromEntries(entries) as Commands<T>;
}
