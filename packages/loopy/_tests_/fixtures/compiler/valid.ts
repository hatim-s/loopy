import { code, fs, loopy } from "loopy/graph";

export default loopy("compiled", {
  input: {},
  run: () => {
    const files = fs.ls();

    return code("count", {
      in: { files },
      out: { kind: "value", type: "number" },
      module: "./count.ts",
    });
  },
});
