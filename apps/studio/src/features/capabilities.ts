export type { ProviderCapabilityListProps } from "./components.tsx";
export { ProviderCapabilityList } from "./components.tsx";
export type { CapabilityStatus, ProviderCapability } from "./types.ts";

export function capabilitiesQuery() {
  return {
    kind: "query" as const,
    key: ["providers", "capabilities"] as const,
    endpoint: "/api/providers/capabilities",
  };
}
