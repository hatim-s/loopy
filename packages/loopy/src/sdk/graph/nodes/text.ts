import { text as runtime } from "../../shell/text.js";
import { defineCommand } from "./command.js";

export const text = {
  grep: defineCommand(runtime.grep.descriptor, { matches: "json[]", binaryMatches: "string[]" }),
  grepCount: defineCommand(runtime.grepCount.descriptor),
  sed: defineCommand(runtime.sed.descriptor),
  awk: defineCommand(runtime.awk.descriptor),
  cut: defineCommand(runtime.cut.descriptor),
  sort: defineCommand(runtime.sort.descriptor),
  uniq: defineCommand(runtime.uniq.descriptor),
  uniqCount: defineCommand(runtime.uniqCount.descriptor),
  head: defineCommand(runtime.head.descriptor),
  tail: defineCommand(runtime.tail.descriptor),
  wc: defineCommand(runtime.wc.descriptor),
  tr: defineCommand(runtime.tr.descriptor),
  diff: defineCommand(runtime.diff.descriptor),
  jq: defineCommand(runtime.jq.descriptor),
  yq: defineCommand(runtime.yq.descriptor),
  base64: defineCommand(runtime.base64.descriptor),
  sha256sum: defineCommand(runtime.sha256sum.descriptor),
};
