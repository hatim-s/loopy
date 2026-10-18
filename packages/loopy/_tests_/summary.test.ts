import { expect, test } from "bun:test";
import { parseSummary } from "../../../examples/uacode-asset-sync/prompt.ts";
import { requestSchema } from "../../../examples/uacode-asset-sync/request.ts";

test("asset summary rejects outside paths, traversal, unsafe characters and unknown checks", async () => {
  const validated = await requestSchema["~standard"].validate({
    repository: "/fixture/uacode",
    assets: [{ assetClass: "asset", assetId: "id" }],
  });

  if (validated.issues) {
    throw new Error("Invalid fixture request");
  }

  const request = validated.value;

  const path = "configs/platform-features/ai-agents/asset-repository/fixture.json";
  expect(
    parseSummary(JSON.stringify({ proposedFiles: [path], checks: ["sync-preview"] }), request),
  ).toEqual({ proposedFiles: [path], checks: ["sync-preview"] });

  for (const proposedFiles of [
    ["outside.json"],
    [path.replace("fixture", "../fixture")],
    [path.replace("fixture", "unsafe name")],
  ]) {
    expect(() => parseSummary(JSON.stringify({ proposedFiles, checks: [] }), request)).toThrow(
      "outside",
    );
  }

  expect(() => parseSummary('{"proposedFiles":[],"checks":["invented"]}', request)).toThrow(
    "Invalid check summary",
  );
  expect(() => parseSummary("not JSON", request)).toThrow("Missing or invalid Codex summary");
});
