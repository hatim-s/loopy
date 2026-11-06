import { code, loopy } from "../../../packages/loopy/src/sdk/graph";

export default loopy("acceptance-invalid", {
  input: {},
  run: () =>
    code("invalid", {
      in: {},
      out: { kind: "value", type: "number" },
      module: "./invalid.ts",
      retry: { attempts: 3 },
    }),
});
