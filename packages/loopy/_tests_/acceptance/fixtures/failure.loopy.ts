import { fail, loopy } from "loopy/graph";

export default loopy("acceptance-failure", {
  input: {},
  run: () => fail("acceptance terminal failure"),
});
