import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Evidence, failureEvidence } from "./assert";

type CheckResult = {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  evidence: Evidence;
};

// Evidence is rewritten after every check so an interrupted journey still leaves its partial record.
export class EvidenceLog {
  readonly results: CheckResult[] = [];
  readonly runs: string[] = [];
  readonly startedAt = new Date().toISOString();

  constructor(
    private readonly path: string,
    private readonly fields: Evidence,
  ) {}

  get passed() {
    return this.results.every((result) => result.status === "passed");
  }

  async check(name: string, action: () => Promise<Evidence | void>) {
    const start = Date.now();
    let result: CheckResult;

    try {
      const evidence = (await action()) ?? {};
      result = { name, status: "passed", durationMs: Date.now() - start, evidence };
    } catch (cause) {
      result = {
        name,
        status: "failed",
        durationMs: Date.now() - start,
        evidence: failureEvidence(cause),
      };
    }

    this.results.push(result);
    await this.save();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  async save(extra: Evidence = {}) {
    await mkdir(dirname(this.path), { recursive: true });
    await Bun.write(
      this.path,
      `${JSON.stringify(
        {
          status: this.passed ? "passed" : "failed",
          ...this.fields,
          startedAt: this.startedAt,
          updatedAt: new Date().toISOString(),
          runIds: this.runs,
          results: this.results,
          ...extra,
        },
        null,
        2,
      )}\n`,
    );
  }
}
