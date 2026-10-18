import { code, log, loopy } from "loopy";

export default loopy("hello", {
  input: { name: "string", "enthusiastic?": "boolean" },
  run: ({ input }) => {
    const greeting = code("greet", {
      in: { name: input.get("name"), enthusiastic: input.get("enthusiastic") },
      out: { greeting: "string" },
      module: "./hello/greet.ts",
    });

    log(greeting.get("greeting"));

    return greeting;
  },
});
