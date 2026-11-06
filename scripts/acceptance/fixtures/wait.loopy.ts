import { loopy, sh, sleep, wait } from "../../../packages/loopy/src/sdk/graph";

export default loopy("acceptance-wait", {
  input: {},
  run: () => {
    sh(["sh", "-c", "echo before >> effects"]);

    const approval = wait("approval", {
      payload: { kind: "record", fields: { answer: "string" } },
      timeout: "30s",
    });

    sleep("1s");
    sh(["sh", "-c", "echo after >> effects"]);

    return approval.get("answer");
  },
});
