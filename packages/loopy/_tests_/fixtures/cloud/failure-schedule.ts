import { loopy, sh, wait } from "loopy/graph";

export default loopy("cloud-failure-schedule", {
  input: {},
  schedule: { cron: "* * * * *", tz: "UTC" },
  run: () => {
    sh.exec(
      ["/bin/sh", "-c", "printf 'fired\\n' >> effects; sleep 75; printf 'finished\\n' >> effects"],
      {
        label: "effect",
        timeout: "90s",
        retry: { attempts: 1 },
      },
    );

    return wait("approval", { payload: { kind: "record", fields: { approved: "boolean" } } });
  },
});
