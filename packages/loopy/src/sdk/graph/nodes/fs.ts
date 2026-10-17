import { fs as runtime } from "../../shell/fs.js";
import { defineCommand } from "./command.js";

export const fs = {
  ls: Object.assign(defineCommand(runtime.ls.descriptor), {
    raw: defineCommand(runtime.ls.raw.descriptor).raw,
  }),
  cat: defineCommand(runtime.cat.descriptor),
  cp: defineCommand(runtime.cp.descriptor),
  mv: defineCommand(runtime.mv.descriptor),
  rm: defineCommand(runtime.rm.descriptor),
  mkdir: defineCommand(runtime.mkdir.descriptor),
  touch: defineCommand(runtime.touch.descriptor),
  find: defineCommand(runtime.find.descriptor),
  tree: defineCommand(runtime.tree.descriptor),
  stat: defineCommand(runtime.stat.descriptor),
  chmod: defineCommand(runtime.chmod.descriptor),
  ln: defineCommand(runtime.ln.descriptor),
  realpath: defineCommand(runtime.realpath.descriptor),
  which: defineCommand(runtime.which.descriptor),
  mktemp: defineCommand(runtime.mktemp.descriptor),
  du: defineCommand(runtime.du.descriptor),
  df: defineCommand(runtime.df.descriptor),
};
