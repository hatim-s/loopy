import { fs as runtime } from "../../shell/fs.js";
import { defineCommand } from "./command.js";

export const fs = {
  ls: Object.assign(
    defineCommand(
      { ...runtime.ls.descriptor, parse: "./parsers/fs-ls.ts" },
      { kind: "value", type: "string[]" },
    ),
    {
      raw: defineCommand(runtime.ls.raw.descriptor).raw,
    },
  ),
  cat: defineCommand(runtime.cat.descriptor),
  cp: defineCommand(runtime.cp.descriptor),
  mv: defineCommand(runtime.mv.descriptor),
  rm: defineCommand(runtime.rm.descriptor),
  mkdir: defineCommand(runtime.mkdir.descriptor),
  touch: defineCommand(runtime.touch.descriptor),
  find: defineCommand(
    { ...runtime.find.descriptor, parse: "./parsers/fs-find.ts" },
    { kind: "value", type: "string[]" },
  ),
  tree: defineCommand(
    { ...runtime.tree.descriptor, parse: "./parsers/fs-tree.ts" },
    { kind: "value", type: "json[]" },
  ),
  stat: defineCommand(
    { ...runtime.stat.descriptor, parse: "./parsers/fs-stat.ts" },
    { kind: "value", type: "json[]" },
  ),
  chmod: defineCommand(runtime.chmod.descriptor),
  ln: defineCommand(runtime.ln.descriptor),
  realpath: defineCommand(
    { ...runtime.realpath.descriptor, parse: "./parsers/fs-realpath.ts" },
    { kind: "value", type: "string" },
  ),
  which: defineCommand(
    { ...runtime.which.descriptor, parse: "./parsers/fs-which.ts" },
    { kind: "value", type: "json" },
  ),
  mktemp: defineCommand(
    { ...runtime.mktemp.descriptor, parse: "./parsers/fs-mktemp.ts" },
    { kind: "value", type: "string" },
  ),
  du: defineCommand(
    { ...runtime.du.descriptor, parse: "./parsers/fs-du.ts" },
    { kind: "value", type: "json[]" },
  ),
  df: defineCommand(
    { ...runtime.df.descriptor, parse: "./parsers/fs-df.ts" },
    { kind: "value", type: "json[]" },
  ),
};
