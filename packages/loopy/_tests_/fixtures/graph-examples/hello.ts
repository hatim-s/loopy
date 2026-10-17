import { code, log, loopy } from "../../../src/sdk/graph/index.js";

export default loopy({
  name: "hello",
  input: { name: "string", "enthusiastic?": "boolean" },
  run: ({ input }) => {
    const greeting = code("greet", {
      in: input,
      out: { greeting: "string" },
      module: "./hello/greet.ts",
    });

    log(greeting.get("greeting"));

    return greeting;
  },
});
