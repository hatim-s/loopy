import { fs as runtime } from "../../shell/fs.js";
import { defineCommand } from "./command.js";

export const fs = {
  ls: Object.assign(defineCommand(runtime.ls.descriptor, { kind: "value", type: "string[]" }), {
    raw: defineCommand(runtime.ls.raw.descriptor).raw,
  }),
  cat: defineCommand(runtime.cat.descriptor),
  cp: defineCommand(runtime.cp.descriptor),
  mv: defineCommand(runtime.mv.descriptor),
  rm: defineCommand(runtime.rm.descriptor),
  mkdir: defineCommand(runtime.mkdir.descriptor),
  touch: defineCommand(runtime.touch.descriptor),
  find: defineCommand(runtime.find.descriptor, { kind: "value", type: "string[]" }),
  tree: defineCommand(runtime.tree.descriptor, { kind: "value", type: "json[]" }),
  stat: defineCommand(runtime.stat.descriptor, { kind: "value", type: "json[]" }),
  chmod: defineCommand(runtime.chmod.descriptor),
  ln: defineCommand(runtime.ln.descriptor),
  realpath: defineCommand(runtime.realpath.descriptor, { kind: "value", type: "string" }),
  which: defineCommand(runtime.which.descriptor, { kind: "value", type: "json" }),
  mktemp: defineCommand(runtime.mktemp.descriptor, { kind: "value", type: "string" }),
  du: defineCommand(runtime.du.descriptor, { kind: "value", type: "json[]" }),
  df: defineCommand(runtime.df.descriptor, { kind: "value", type: "json[]" }),
};
