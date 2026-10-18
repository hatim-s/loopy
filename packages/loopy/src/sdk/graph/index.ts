import { archive as archiveImpl } from "../shell/archive.js";
import { fs as fsImpl } from "../shell/fs.js";
import { git as gitImpl } from "../shell/git.js";
import { net as netImpl } from "../shell/net.js";
import { text as textImpl } from "../shell/text.js";
import { loopy as loopyImpl } from "./loopy.js";
import { code as codeImpl } from "./nodes/code.js";
import { defineCommand as defineCommandImpl, sh as shImpl } from "./nodes/command.js";
import {
  branch as branchImpl,
  fail as failImpl,
  finally_ as finally_Impl,
  map as mapImpl,
  parallel as parallelImpl,
  rescue as rescueImpl,
  switch_ as switch_Impl,
} from "./nodes/control.js";
import { subgraph as subgraphImpl } from "./nodes/subgraph.js";
import {
  format as formatImpl,
  log as logImpl,
  now as nowImpl,
  random as randomImpl,
  uuid as uuidImpl,
} from "./nodes/values.js";
import { sleep as sleepImpl, wait as waitImpl } from "./nodes/wait.js";
import {
  and as andImpl,
  eq as eqImpl,
  exists as existsImpl,
  gte as gteImpl,
  gt as gtImpl,
  in_ as in_Impl,
  isNull as isNullImpl,
  lte as lteImpl,
  lt as ltImpl,
  ne as neImpl,
  not as notImpl,
  or as orImpl,
  size as sizeImpl,
} from "./predicates.js";

const exports = {
  loopy: loopyImpl,
  archive: archiveImpl,
  code: codeImpl,
  defineCommand: defineCommandImpl,
  sh: shImpl,
  branch: branchImpl,
  fail: failImpl,
  finally_: finally_Impl,
  map: mapImpl,
  parallel: parallelImpl,
  rescue: rescueImpl,
  switch_: switch_Impl,
  fs: fsImpl,
  git: gitImpl,
  net: netImpl,
  subgraph: subgraphImpl,
  text: textImpl,
  format: formatImpl,
  log: logImpl,
  now: nowImpl,
  random: randomImpl,
  uuid: uuidImpl,
  sleep: sleepImpl,
  wait: waitImpl,
  and: andImpl,
  eq: eqImpl,
  exists: existsImpl,
  gt: gtImpl,
  gte: gteImpl,
  in_: in_Impl,
  isNull: isNullImpl,
  lt: ltImpl,
  lte: lteImpl,
  ne: neImpl,
  not: notImpl,
  or: orImpl,
  size: sizeImpl,
};

export const {
  loopy,
  archive,
  code,
  defineCommand,
  sh,
  branch,
  fail,
  finally_,
  map,
  parallel,
  rescue,
  switch_,
  fs,
  git,
  net,
  subgraph,
  text,
  format,
  log,
  now,
  random,
  uuid,
  sleep,
  wait,
  and,
  eq,
  exists,
  gt,
  gte,
  in_,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  size,
} = exports;

export type { Ref } from "./ref.js";

export type { Infer } from "./types.js";

export { GraphBuildError } from "./validate.js";

type SdkFunction = (...args: never[]) => void;

type SdkMember = SdkFunction | { [name: string]: SdkMember };

function isFunction(value: SdkMember): value is SdkFunction {
  return typeof value === "function";
}

function calls(value: SdkMember, prefix = "", ancestors = new Set<SdkMember>()): string[] {
  const seen = new Set(ancestors).add(value);
  const entries: [string, SdkMember][] = Object.entries(value);

  return entries.flatMap(([key, member]) => {
    if (key === "descriptor") {
      return [];
    }

    const path = prefix ? `${prefix}.${key}` : key;

    if (isFunction(member)) {
      return [path, ...(seen.has(member) ? [] : calls(member, path, seen))];
    }

    return calls(member, path, seen);
  });
}

export const sdkCalls = calls(exports);
