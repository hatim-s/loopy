import type * as graph from "./graph";

/** How the restricted compiler treats one option key beyond ordinary graph values. */
type OptionRole = "literal" | "module" | "callback";

/** The argument roles of one SDK call, which the restricted compiler enforces before evaluation. */
export type CallSyntax = {
  /** The first argument is a string literal. */
  readonly label?: true;
  /** The argument position, or every position, that must be an inline object literal. */
  readonly options?: number | "all";
  readonly keys?: Readonly<Record<string, OptionRole>>;
  /** Where synchronous arrow callbacks may appear: as arguments, or as every options property. */
  readonly callbacks?: "arguments" | "options";
  readonly binding?: "graph" | "command" | "subgraph";
  /** Calls whose source range the saved source artifact attributes to the node they create. */
  readonly source?: "code" | "wait";
};

/** Author-declared commands and built-in commands take operands first and options second. */
export const COMMAND_CALL: CallSyntax = { options: 1, keys: { label: "literal" } };

const plain: CallSyntax = {};

export const CALL_SYNTAX = {
  loopy: { label: true, options: 1, keys: { run: "callback" }, binding: "graph" },
  code: { label: true, options: 1, keys: { module: "module" }, source: "code" },
  wait: { label: true, options: 1, source: "wait" },
  subgraph: { label: true, callbacks: "arguments", binding: "subgraph" },
  defineCommand: {
    options: "all",
    keys: { key: "literal", parse: "module" },
    binding: "command",
  },
  sh: COMMAND_CALL,
  archive: "namespace",
  fs: "namespace",
  git: "namespace",
  net: "namespace",
  text: "namespace",
  branch: { options: 1, callbacks: "options" },
  switch_: { options: 1, callbacks: "options" },
  parallel: { options: "all", callbacks: "options" },
  map: { options: 2, callbacks: "arguments" },
  finally_: { callbacks: "arguments" },
  rescue: { callbacks: "arguments" },
  fail: plain,
  format: plain,
  log: plain,
  now: plain,
  random: plain,
  uuid: plain,
  sleep: plain,
  and: plain,
  eq: plain,
  exists: plain,
  gt: plain,
  gte: plain,
  in_: plain,
  isNull: plain,
  lt: plain,
  lte: plain,
  ne: plain,
  not: plain,
  or: plain,
  size: plain,
} as const satisfies {
  readonly [K in keyof typeof graph]: CallSyntax | "namespace";
};
