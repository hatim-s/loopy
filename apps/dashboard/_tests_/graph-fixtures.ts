import { graphView } from "@loopy/contract";
import {
  branch,
  code,
  eq,
  fail,
  finally_,
  format,
  log,
  loopy,
  lte,
  map,
  parallel,
  type Ref,
  rescue,
  sh,
  size,
  sleep,
  subgraph,
  switch_,
  wait,
} from "@loopy/sdk/graph";

const text = { kind: "value", type: "string" } as const;

export const REVIEW = graphView(
  loopy("review", {
    input: { "instructions?": "string" },
    run: () => {
      const changes = sh(["git", "diff", "--stat"], { label: "changes" });

      return branch(lte(size(changes.get("stdout")), 0), {
        yes: () => log("Nothing to review."),
        no: () => {
          const diff = sh(["git", "diff"], { label: "diff" });
          const prompt = code("prompt", { in: { diff }, out: text, module: "./prompt.ts" });
          sh(["codex", "exec", "-", "--sandbox", "read-only"], { label: "review", stdin: prompt });

          return log("Reviewed.");
        },
      });
    },
  }),
);

const triage = (version: 1 | 2) =>
  graphView(
    loopy("triage-inbox", {
      input: { mailbox: "string", since: "string" },
      run: ({ input }) => {
        const mail = sh(["bun", "fetch-unread.ts", input.get("mailbox"), input.get("since")], {
          label: "fetch",
        });

        const sorted = code("classify", { in: { mail }, out: text, module: "./classify.ts" });

        if (version === 2) {
          log("Classified.");
        }

        return code("reply", { in: { sorted }, out: text, module: "./reply.ts" });
      },
    }),
  );

export const TRIAGE_V1 = triage(1);

export const TRIAGE_V2 = triage(2);

const publish = subgraph("publish", (name: Ref<string>) => {
  sh(["bun", "run", "build", "--filter", name], { label: "build" });

  const pack = code("pack", {
    in: { name },
    out: { kind: "record", fields: { file: "string" } },
    module: "./pack.ts",
  });

  return rescue(
    () => sh(["npm", "publish", pack.get("file"), "--access", "public"], { label: "upload" }),
    (error) => {
      const message = format("{name} failed: {message}", { name, message: error.get("message") });
      log(message);

      return code("notify", { in: { message }, out: text, module: "./notify.ts" });
    },
  );
});

export const RELEASE = graphView(
  loopy("release", {
    input: { channel: "string", "notes?": "string" },
    run: ({ input }) => {
      const status = sh(["git", "status", "--porcelain"], { label: "status" });

      const plan = code("plan", {
        in: { status },
        out: {
          kind: "record",
          fields: { dirty: "boolean", version: "string", packages: "string[]" },
        },
        module: "./plan.ts",
      });

      branch(eq(plan.get("dirty"), true), {
        yes: () => fail("The working tree has uncommitted changes."),
        no: () => log("Clean tree."),
      });

      parallel({
        lint: () => sh(["bun", "run", "lint"], { label: "lint" }),
        test: () => sh(["bun", "test"], { label: "test" }),
        types: () => sh(["bun", "run", "typecheck"], { label: "typecheck" }),
      });

      map(plan.get("packages"), (name) => publish(name), { concurrency: 2, onError: "collect" });
      code("notes", { in: { plan }, out: text, module: "./notes.ts" });

      const approval = wait("approve", {
        payload: { kind: "record", fields: { approved: "boolean" } },
      });

      branch(eq(approval.get("approved"), false), {
        yes: () => fail("Release was declined."),
        no: () => null,
      });

      return finally_(
        () => {
          switch_(input.get("channel"), {
            stable: () => sh(["git", "tag", plan.get("version")], { label: "tag" }),
            beta: () =>
              sh(["git", "tag", format("{version}-beta", { version: plan.get("version") })], {
                label: "tag-beta",
              }),
            default: () => log("Unknown channel."),
          });
          code("deploy", { in: { plan }, out: text, module: "./deploy.ts" });
          sleep("1m");

          return code("verify", { in: { plan }, out: text, module: "./verify.ts" });
        },
        () => sh(["rm", "-rf", "dist"], { label: "clean" }),
      );
    },
  }),
);
