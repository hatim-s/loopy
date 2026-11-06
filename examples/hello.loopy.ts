import { loopy, step } from "loopy";

export default loopy({
  name: "hello",
  description: "Greet someone and record the result as a durable step.",
  input: { name: "string", "enthusiastic?": "boolean" },
  run: async ({ input, log }) => {
    const greeting = await step(
      "greet",
      () => `Hello, ${input.name}${input.enthusiastic ? "!" : "."}`,
    );

    log.info(greeting);

    return { greeting };
  },
});
