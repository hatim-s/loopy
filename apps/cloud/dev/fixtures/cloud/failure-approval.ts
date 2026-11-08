import { loopy, wait } from "loopy";

export default loopy("cloud-failure-approval", {
  input: {},
  run: () => wait("approval", { payload: { kind: "record", fields: { approved: "boolean" } } }),
});
