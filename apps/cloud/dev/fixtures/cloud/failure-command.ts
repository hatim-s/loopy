import { loopy, sh } from "loopy";

export default loopy("cloud-failure-command", {
  input: {},
  run: () =>
    sh.exec(
      [
        "/bin/sh",
        "-c",
        "printf 'started\\n' >> effects; sleep 12; printf 'finished\\n' >> effects; wc -l < effects",
      ],
      { label: "effect", timeout: "40s", retry: { attempts: 3, retryOnExit: true } },
    ),
});
