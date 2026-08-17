import { type ComponentType, type LazyExoticComponent, lazy } from "react";

export type FeatureKey =
  | "overview"
  | "providers"
  | "sessions"
  | "extractions"
  | "runs"
  | "workflows"
  | "settings";
export type FeaturePageProps = { feature: FeatureKey };
export type FeaturePage = ComponentType<FeaturePageProps>;
export type FeaturePageLoader = () => Promise<{ default: FeaturePage }>;
export type FeaturePageRegistry = Partial<Record<FeatureKey, FeaturePageLoader>>;

const labels: Record<FeatureKey, string> = {
  overview: "Workspace overview",
  providers: "Provider connections",
  sessions: "Agent sessions",
  extractions: "Trace extractions",
  runs: "Workflow runs",
  workflows: "Workflow library",
  settings: "Studio settings",
};

function makeDefaultPage(feature: FeatureKey): FeaturePage {
  return function FeatureSlot() {
    return (
      <section className="feature-slot" aria-labelledby={`${feature}-slot-title`}>
        <div className="feature-slot__eyebrow">{feature}</div>
        <h1 id={`${feature}-slot-title`}>{labels[feature]}</h1>
        <p>This panel is a ready seam for the debugger feature package.</p>
        <div className="feature-slot__boundary">
          <span className="status-dot status-dot--idle" aria-hidden="true" />
          <span>Waiting for feature data</span>
        </div>
      </section>
    );
  };
}

export const defaultFeaturePages: Record<FeatureKey, FeaturePageLoader> = {
  overview: () => Promise.resolve({ default: makeDefaultPage("overview") }),
  providers: () => Promise.resolve({ default: makeDefaultPage("providers") }),
  sessions: () => Promise.resolve({ default: makeDefaultPage("sessions") }),
  extractions: () => Promise.resolve({ default: makeDefaultPage("extractions") }),
  runs: () => Promise.resolve({ default: makeDefaultPage("runs") }),
  workflows: () => Promise.resolve({ default: makeDefaultPage("workflows") }),
  settings: () => Promise.resolve({ default: makeDefaultPage("settings") }),
};

export function createFeaturePages(
  overrides: FeaturePageRegistry = {},
): Record<FeatureKey, LazyExoticComponent<FeaturePage>> {
  const pages = { ...defaultFeaturePages, ...overrides };
  return Object.fromEntries(
    (Object.keys(pages) as FeatureKey[]).map((key) => [key, lazy(pages[key])]),
  ) as Record<FeatureKey, LazyExoticComponent<FeaturePage>>;
}
