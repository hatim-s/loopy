import { routes } from "@loopy/contract";
import { Effect } from "effect";
import { request } from "../client";
import { defineCommand, RUN_ID } from "../command";
import { parseJsonText } from "../json";
import { printLine } from "../output";

export const hook = defineCommand({
  path: ["hook"],
  summary: "Resolve a waiting hook",
  options: {
    payload: { type: "string", value: "json", description: "Hook payload as JSON. Default: null." },
  },
  positionals: [RUN_ID, { name: "name", label: "Hook name" }],
  run: (cli) =>
    Effect.gen(function* () {
      const [runId, name] = cli.args;
      const payload = yield* parseJsonText(cli.values.payload ?? "null", "--payload");
      yield* request(
        cli,
        `/runs/${encodeURIComponent(runId)}/hooks/${encodeURIComponent(name)}`,
        routes.resolveNamedHook.response,
        { method: "POST", body: { payload } },
      );
      printLine(`Resolved hook '${name}' for run ${runId}. The run is ready to continue.`);
    }),
});
