import { fail, finally_, loopy, rescue, sh } from "../../../packages/loopy/src/sdk/graph";

export default loopy("acceptance-recovery", {
  input: {},
  run: () => {
    const retried = sh(
      [
        "sh",
        "-c",
        "echo attempt >> attempts; test $(wc -l < attempts) -eq 2 || exit 17; printf recovered",
      ],
      { label: "retry-command", retry: { attempts: 2, retryOnExit: true } },
    );

    const rescued = finally_(
      () =>
        rescue(
          () => fail("expected authored failure"),
          (error) => error.get("message"),
        ),
      () => sh(["sh", "-c", "echo cleanup >> cleanup"]),
    );

    return { retried: retried.get("stdout"), rescued };
  },
});
