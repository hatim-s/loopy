import { code, log, loopy, wait } from "../../../src/sdk/graph/index.js";

export default loopy("cloud-journey-approval", {
  input: { name: "string" },
  description: "Journey revision two",
  run: ({ input }) => {
    const approval = wait("approval", {
      payload: { kind: "record", fields: { approved: "boolean" } },
    });

    log("approval-resolved", approval);

    const result = code("version", {
      in: { name: input.get("name"), approved: approval.get("approved") },
      out: { kind: "record", fields: { version: "number", name: "string", approved: "boolean" } },
      module: "./version-two.ts",
      retry: { attempts: 1 },
    });

    return result;
  },
});
