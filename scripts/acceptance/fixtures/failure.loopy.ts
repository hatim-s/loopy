import { fail, loopy } from "../../../packages/loopy/src/sdk/graph";

export default loopy("acceptance-failure", {
  input: {},
  run: () => fail("acceptance terminal failure"),
});
