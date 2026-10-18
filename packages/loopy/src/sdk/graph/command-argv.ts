import { type CommandFlagSpec, isBoolean, isNumber, isRecord, isString } from "../../core/index.js";
import {
  type CommandDefinition,
  type CommandDescriptor,
  parsedFlags,
  platformVariant,
} from "../define-command.js";
import { renderOperands } from "../render-argv.js";
import { type AuthorValue, isRef, type RefValue } from "./ref.js";
import { refuse } from "./validate.js";

type Input = {
  args?: readonly (string | RefValue)[];
  revisions?: readonly (string | RefValue)[];
  paths?: readonly (string | RefValue)[];
  flags?: Readonly<Record<string, AuthorValue>>;
};

// prepare uses argument counts and flag presence; opaque tokens keep its legacy string API isolated.
class Preparation {
  private readonly values = new Map<string, AuthorValue>();

  encode = (value: AuthorValue): AuthorValue => {
    if (isRef(value) || isString(value)) {
      const key = `\u0000${this.values.size}\u0000`;
      this.values.set(key, value);

      return key;
    }

    if (Array.isArray(value)) {
      return value.map(this.encode);
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.encode(item)]),
      );
    }

    return value;
  };

  // BOUNDARY: Legacy descriptor prepare returns RenderInput's unknown flag values.
  decode(value: unknown): AuthorValue {
    if (isString(value)) {
      return this.values.get(value) ?? value;
    }

    if (value === null || value === undefined || isNumber(value) || isBoolean(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((child) => this.decode(child));
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.decode(item)]),
      );
    }

    return refuse("unresolved_ref", "Descriptor preparation must return literals or references.");
  }

  input(input: Input) {
    return {
      args: input.args?.map(this.encode).map(String),
      revisions: input.revisions?.map(this.encode).map(String),
      paths: input.paths?.map(this.encode).map(String),
      flags: Object.fromEntries(
        Object.entries(input.flags ?? {}).map(([name, value]) => [name, this.encode(value)]),
      ),
    };
  }
}

function flagSpec(descriptor: CommandDefinition): CommandFlagSpec {
  return {
    path: [...(descriptor.path ?? [])],
    flags: { ...descriptor.flags },
    style: descriptor.style ?? "space",
    positionalSeparator: Boolean(descriptor.positionalSeparator && !descriptor.revisionPaths),
    flagsAfterPositionals: descriptor.flagsAfterPositionals ?? false,
  };
}

export function commandArgv(
  original: Omit<CommandDescriptor, "parse">,
  input: Input,
  mode: "parsed" | "raw",
) {
  const descriptor = platformVariant(original, process.platform);
  const key = original.key ?? `${original.namespace}.${original.name}`;
  const codec = new Preparation();
  const flags = mode === "parsed" ? parsedFlags(descriptor, { flags: input.flags }) : input.flags;
  const encoded = codec.input({ ...input, flags });
  const prepared = mode === "parsed" ? (descriptor.prepare?.(encoded) ?? encoded) : encoded;

  const operands = {
    ...descriptor,
    positionals:
      mode === "parsed"
        ? (descriptor.parsedPositionals ?? descriptor.positionals)
        : descriptor.positionals,
  };

  return {
    parseInput: Object.fromEntries(
      Object.entries(prepared)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name, codec.decode(value)]),
    ),
    program: descriptor.program,
    argv: renderOperands(operands, prepared, key).map((value) => codec.decode(value)),
    flagSpec: flagSpec(descriptor),
    flags: Object.fromEntries(
      Object.entries(prepared.flags ?? {}).map(([name, value]) => [name, codec.decode(value)]),
    ),
  };
}
