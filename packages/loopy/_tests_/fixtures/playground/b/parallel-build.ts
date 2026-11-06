import { branch, code, eq, fail, log, loopy, parallel } from "../../../../src/sdk/graph";

export default loopy("playground-b-parallel-build", {
  description: "Build client and server summaries in parallel from seeded CI data",
  input: { batch: "string", ordinal: "number", fail: "boolean", items: "number[]" },
  run: ({ input }) => {
    code("seed", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
      },
      out: { kind: "record", fields: { count: "number" } },
      module: "./modules/seed.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });

    const builds = parallel({
      client: () =>
        code("client-build", {
          in: { target: "client" },
          out: { kind: "record", fields: { bytes: "number" } },
          module: "./modules/build-target.ts",
          retry: { attempts: 1 },
          timeout: "10s",
        }),
      server: () =>
        code("server-build", {
          in: { target: "server" },
          out: { kind: "record", fields: { bytes: "number" } },
          module: "./modules/build-target.ts",
          retry: { attempts: 1 },
          timeout: "10s",
        }),
    });

    branch(eq(input.get("fail"), true), {
      yes: () => fail("Controlled build size policy failure"),
      no: () => log("parallel-build-passed", builds),
    });

    return code("report", {
      in: {
        batch: input.get("batch"),
        ordinal: input.get("ordinal"),
        fail: input.get("fail"),
        items: input.get("items"),
        builds,
      },
      out: {
        kind: "record",
        fields: { artifactPath: "string", checksum: "number", entries: "number" },
      },
      module: "./modules/build-report.ts",
      retry: { attempts: 1 },
      timeout: "10s",
    });
  },
});
