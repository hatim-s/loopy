import { loopy, wait } from "../../../src/sdk/graph/index.js";

export default loopy("cloud-failure-approval", {
  input: {},
  run: () => wait("approval", { payload: { kind: "record", fields: { approved: "boolean" } } }),
});
