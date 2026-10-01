import { command, concat, contains, node, trigger } from "loopy";

export default trigger<{ message: string }>("hello")
  .description("Pass input between CLI commands and choose a branch.")
  .node("echo", ({ input }) => command("printf", "%s", input.message))
  .node("count", ({ steps }) => ({ ...command("wc", "-c"), stdin: steps.echo.stdout }))
  .condition(
    "greeting",
    ({ steps }) => contains(steps.echo.stdout, "hello"),
    ({ steps }) =>
      node("welcome", command("printf", "%s", concat("Received: ", steps.echo.stdout))),
    node("other", command("printf", "%s", "Message recorded.")),
  );
