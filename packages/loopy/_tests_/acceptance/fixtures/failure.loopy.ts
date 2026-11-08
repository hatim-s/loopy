import { fail, loopy } from "loopy";

export default loopy("acceptance-failure", {
  input: {},
  run: () => fail("acceptance terminal failure"),
});
