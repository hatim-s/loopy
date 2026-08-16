import type {
  CapabilityReport,
  ProviderAdapter,
  ProviderEvent,
  ProviderProbe,
  ProviderRequest,
  ProviderRun,
  ProviderSession,
} from "@loopy/providers";

export type ConformanceCheck = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type ProviderConformanceResult = {
  provider: string;
  passed: boolean;
  checks: ConformanceCheck[];
  probe?: ProviderProbe;
};

function check(checks: ConformanceCheck[], name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, detail: passed ? undefined : detail });
}

function assertReport(report: CapabilityReport): string | undefined {
  for (const [name, capability] of Object.entries(report.capabilities)) {
    if (!capability) continue;
    if (capability.status !== "supported" && !capability.reason?.trim())
      return `${name} is ${capability.status} without a reason`;
  }
  for (const [status, list] of Object.entries({
    supported: report.supported,
    degraded: report.degraded,
    unavailable: report.unavailable,
  })) {
    const expected = Object.entries(report.capabilities)
      .filter(([, capability]) => capability?.status === status)
      .map(([name]) => name)
      .sort();
    if (JSON.stringify([...list].sort()) !== JSON.stringify(expected))
      return `${status} capability projection is stale`;
  }
  return undefined;
}

async function firstEvent(run: ProviderRun): Promise<ProviderEvent | undefined> {
  for await (const event of run.events) return event;
  return undefined;
}

export async function runProviderConformance(
  adapter: ProviderAdapter,
  options: { exercise?: ProviderRequest } = {},
): Promise<ProviderConformanceResult> {
  const checks: ConformanceCheck[] = [];
  check(checks, "provider id", Boolean(adapter.id?.trim()), "Provider id is required.");
  check(
    checks,
    "provider version",
    Boolean(adapter.version?.trim()),
    "Provider version is required.",
  );
  let probe: ProviderProbe | undefined;
  try {
    probe = await adapter.probe();
    check(
      checks,
      "probe identity",
      probe.provider === adapter.id,
      "Probe provider does not match adapter id.",
    );
    check(
      checks,
      "probe diagnostic safety",
      !/[\r\n]?(?:Bearer|api[_-]?key|secret|password)\s*[:=]/i.test(probe.diagnostic ?? ""),
      "Probe diagnostic may expose credentials.",
    );
  } catch (error) {
    check(checks, "probe", false, String(error));
  }
  try {
    const report = adapter.capabilities();
    const error = assertReport(report);
    check(checks, "honest capability report", !error, error);
  } catch (error) {
    check(checks, "honest capability report", false, String(error));
  }
  for (const descriptor of adapter.historicalImports) {
    check(
      checks,
      `historical import descriptor ${descriptor.id}`,
      Boolean(descriptor.formats.length),
      "Import formats are required.",
    );
  }
  if (options.exercise && probe?.available) {
    let run: ProviderRun | undefined;
    try {
      run = await adapter.start(options.exercise);
      const session = await run.session;
      check(
        checks,
        "session provenance",
        Boolean(session.provider === adapter.id && session.sessionId),
        "Session is missing provider provenance.",
      );
      const event = await firstEvent(run);
      if (event) {
        check(
          checks,
          "event provenance",
          event.provider === adapter.id,
          "Event provider does not match adapter id.",
        );
        check(checks, "event timestamp", Boolean(event.occurredAt), "Event timestamp is required.");
      }
      check(
        checks,
        "normalized events",
        event === undefined || typeof event.type === "string",
        "Provider event type is not normalized.",
      );
      await run.cancel();
    } catch (error) {
      check(checks, "start/cancel", false, String(error));
    }
  }
  return { provider: adapter.id, passed: checks.every((item) => item.passed), checks, probe };
}

export function createFakeProviderAdapter(input: {
  id?: string;
  available?: boolean;
  capabilityReport: CapabilityReport;
  version?: string;
  events?: readonly ProviderEvent[];
}): ProviderAdapter {
  const id = input.id ?? "fake";
  const events = input.events ?? [];
  return {
    id,
    version: input.version ?? "fake-1.0.0",
    capabilities: () => input.capabilityReport,
    probe: async () => ({
      provider: id,
      available: input.available ?? true,
      version: input.version ?? "fake-1.0.0",
      capabilities: input.capabilityReport,
      diagnostic: input.available === false ? "Optional executable is not installed." : undefined,
    }),
    start: async (request) => {
      const session: ProviderSession = { provider: id, sessionId: `fake-${request.attemptId}` };
      let cancelled = false;
      return {
        session: Promise.resolve(session),
        events: (async function* () {
          for (const event of events) {
            if (cancelled) return;
            yield {
              ...event,
              provider: id,
              provenance: {
                ...event.provenance,
                runId: request.runId,
                attemptId: request.attemptId,
              },
            };
          }
        })(),
        cancel: async () => {
          cancelled = true;
        },
      };
    },
    historicalImports: [],
  };
}
