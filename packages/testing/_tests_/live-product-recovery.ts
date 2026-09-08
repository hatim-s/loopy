import {
  type AcceptanceProvider,
  acceptanceProviders,
  runProductRecovery,
} from "./product-recovery";

const provider = process.argv[2];
const model = process.argv[3];
if (process.env.LOOPY_LIVE_ACCEPTANCE !== "1") {
  throw new Error(
    "Live acceptance invokes paid provider calls. Set LOOPY_LIVE_ACCEPTANCE=1 explicitly.",
  );
}
if (!acceptanceProviders.includes(provider as AcceptanceProvider) || !model) {
  throw new Error(
    "Usage: LOOPY_LIVE_ACCEPTANCE=1 bun packages/testing/_tests_/live-product-recovery.ts <codex|claude|pi|opencode> <model>",
  );
}
if (provider === "codex" && model !== "gpt-5.6-luna") {
  throw new Error("Codex acceptance requires gpt-5.6-luna with low reasoning.");
}
const result = await runProductRecovery({
  providerId: provider as AcceptanceProvider,
  model,
  retain: true,
});
console.log(JSON.stringify(result, null, 2));
