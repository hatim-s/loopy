import { loopy, sh, sleep } from "loopy";

export default loopy("acceptance-sleep", {
  input: {},
  run: () => {
    sh(["sh", "-c", "echo before >> sleep-effects"]);
    sleep("5s");
    sh(["sh", "-c", "echo after >> sleep-effects"]);

    return "awake";
  },
});
