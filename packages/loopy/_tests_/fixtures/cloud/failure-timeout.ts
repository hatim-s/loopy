import { loopy, sh } from "../../../src/sdk/graph/index.js";

export default loopy("cloud-failure-timeout", {
  input: {},
  run: () =>
    sh.exec(
      [
        "/bin/sh",
        "-c",
        "printf 'started\\n' >> effects; sleep 30; printf 'finished\\n' >> effects",
      ],
      { label: "effect", timeout: "1s", retry: { attempts: 1 } },
    ),
});
