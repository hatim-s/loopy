import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Json } from "loopy";
import { requestSchema } from "../../../examples/uacode-asset-sync/request.js";
import {
  type Files,
  object,
  parse,
  read,
  readJson,
  writeJson as writeAssetJson,
} from "../../../examples/www-uacode-sync/json-edit.ts";
import {
  parsePullRequests,
  selectPullRequest,
} from "../../../examples/www-uacode-sync/publication.ts";
import {
  applyAssetSync,
  sourceText,
  syncCommitMessage,
  syncMetadata,
} from "../../../examples/www-uacode-sync/sync.ts";
import { makeFixture } from "./fixtures/examples.ts";

const root = "";

const assetRoot = "configs/platform-features/ai-agents/asset-repository";

const agentIds = [
  "e_6aa19955aeb9ea1371af57c7",
  "e_6a801aea757839657bbec2a1",
  "e_ai_fde_agent",
] as const;

const workflowAgentId = "e_6aa19955aeb9ea1371af57c7";

const plannerAgentId = "e_6a801aea757839657bbec2a1";

const firstSkillName = "external-data-inspection";

const firstSkillId = "e_6ab1053b200bf5533fd0ad0b";

const lastSkillId = "e_6a5f2c12f62c9924bb176689";

const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";

const releasePath = join(root, assetRoot, "ENTITY_TYPE/ai_sdlc_feature_release.jsonl");

function writeJson(files: Files, path: string, value: Json) {
  files[path] = JSON.stringify(value, null, 2);
}

test("strips the maintainer-only note from the canonical Workflow Agent prompt", () => {
  expect(
    sourceText(
      "# Workflow Agent prompt\n\n<!--\nMAINTAINER NOTE\nprivate note\n-->\n\nPrompt\n",
      true,
    ),
  ).toBe("# Workflow Agent prompt\n\nPrompt\n");
  expect(sourceText("# Workflow Agent prompt\n\nPrompt\n", true)).toBe(
    "# Workflow Agent prompt\n\nPrompt\n",
  );
  expect(() =>
    sourceText("# Workflow Agent prompt\n\n<!--\nMAINTAINER NOTE\nunterminated", true),
  ).toThrow("missing its maintainer-note block");
});

test("reuses the single open generated sync PR for its base across source SHA changes", () => {
  const mainCandidate = {
    url: "https://github.com/unify-apps/uacode/pull/48961",
    headRefName: "chore/www-agent-assets-ed6ab8d6-main",
  };

  const candidates = [
    mainCandidate,
    {
      url: "https://github.com/unify-apps/uacode/pull/123",
      headRefName: "feature/something-main",
    },
    {
      url: "https://github.com/unify-apps/uacode/pull/48962",
      headRefName: "chore/www-agent-assets-ed6ab8d6-uat",
    },
  ];

  expect(selectPullRequest(candidates, "main")).toEqual(candidates[0] ?? null);
  expect(selectPullRequest(candidates, "uat")).toEqual(candidates[2] ?? null);
  expect(selectPullRequest(candidates, "release/1")).toBeNull();
  expect(() =>
    selectPullRequest(
      [mainCandidate, { ...mainCandidate, headRefName: "chore/www-agent-assets-550febe0-main" }],
      "main",
    ),
  ).toThrow("multiple open www asset sync PRs for base main");
});

test("updates registered skill copies once and preserves export metadata and JSON layout", () => {
  const { content, files } = makeFixture();
  const workflowAgentPath = join(root, assetRoot, "ai_agent", `${agentIds[0]}.json`);
  const compactSkillPath = join(root, assetRoot, "e_skill_ai_agent", `${firstSkillId}.json`);

  const originalManifest = read(
    files,
    join(root, "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json"),
  );

  const manifestPath = join(
    root,
    "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  );

  const firstChanges = applyAssetSync(files, content, sourceSha);
  const secondChanges = applyAssetSync(files, content, sourceSha);
  expect(firstChanges).toHaveLength(13);
  expect(secondChanges).toEqual([]);
  assertPreservedAssets({
    files,
    content,
    workflowAgentPath,
    compactSkillPath,
    manifestPath,
    originalManifest,
  });
  assertReleaseVersions(files);
});

test("bumps only the release feature affected by a later Workflow Agent change", () => {
  const { content, files } = makeFixture();
  applyAssetSync(files, content, sourceSha);
  content.set(workflowAgentId, "updated Workflow Agent prompt\n");

  const changes = applyAssetSync(files, content, sourceSha);

  const releases = read(files, releasePath)
    .trim()
    .split("\n")
    .map((line) => object(object(parse(line), "release").properties, "release properties"));

  expect(changes).toContain(`${assetRoot}/ai_agent/${workflowAgentId}.json`);
  expect(releases.slice(0, 3).map((record) => record.version)).toEqual([
    "1.1.30",
    "2.4.20",
    "3.0.19",
  ]);
});

test("fails before syncing a skill whose embedded and standalone export versions disagree", () => {
  const { content, files } = makeFixture(true);
  expect(() => applyAssetSync(files, content, sourceSha)).toThrow(
    "Standalone and embedded skill versions differ",
  );
});

test("adds a missing skill registration to the manifest without rewriting other registration data", () => {
  const { content, files } = makeFixture();

  const manifestPath = join(
    root,
    "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  );

  const manifest = readJson(files, manifestPath);
  const details = object(manifest.assetClassVsAssetDetails, "manifest");
  const entries = details.e_skill_ai_agent;

  if (!Array.isArray(entries)) {
    throw new Error("Fixture manifest has no skill registrations.");
  }

  details.e_skill_ai_agent = entries.filter(
    (entry) => object(entry, "registration").assetId !== lastSkillId,
  );
  writeJson(files, manifestPath, manifest);
  const changes = applyAssetSync(files, content, sourceSha);
  const updated = object(readJson(files, manifestPath).assetClassVsAssetDetails, "manifest");

  expect(changes).toContain(
    "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  );
  expect(updated.e_skill_ai_agent).toEqual(
    expect.arrayContaining([expect.objectContaining({ assetId: lastSkillId })]),
  );
  expect(updated.ai_agent).toEqual(details.ai_agent);
});

test("rejects malformed asset-specific frontmatter instead of replacing its name", () => {
  const { content, files } = makeFixture();
  const path = join(root, assetRoot, "ai_agent", `${plannerAgentId}.json`);
  const asset = readJson(files, path);
  object(object(asset.aiAgentEntity, "agent").properties, "properties").instructions =
    "---\ndescription: no name\n---\nold body\n";
  writeJson(files, path, asset);

  expect(() => applyAssetSync(files, content, sourceSha)).toThrow(
    "Agent frontmatter must include a name field",
  );
});

test("generated metadata rejects unknown commits and truncated PR lists", () => {
  const base = "a".repeat(40);
  expect(syncMetadata(syncCommitMessage(sourceSha, base))).toEqual({ source: sourceSha, base });
  expect(() => syncMetadata("manual commit")).toThrow("unrecognized");
  expect(() => parsePullRequests(JSON.stringify(Array(500).fill({})))).toThrow("complete list");
});

function assertReleaseVersions(files: Files) {
  const releaseLines = read(files, releasePath).trim().split("\n");

  const releases = releaseLines.map((line) =>
    object(object(parse(line), "release").properties, "release properties"),
  );

  expect(releases.slice(0, 3).map((record) => record.version)).toEqual([
    "1.1.30",
    "2.4.20",
    "3.0.18",
  ]);
  expect(releases.slice(0, 3).map((record) => record.message)).toEqual(
    Array(3).fill(`Sync www agent prompts and skills from ${sourceSha.slice(0, 12)}`),
  );
  expect(releaseLines[3]).toBe(
    JSON.stringify({
      properties: { featureId: "unrelated", version: "1.2.3", message: "preserve" },
    }),
  );
}

function assertPreservedAssets(input: {
  files: Files;
  content: Map<string, string>;
  workflowAgentPath: string;
  compactSkillPath: string;
  manifestPath: string;
  originalManifest: string;
}) {
  const { files, content, workflowAgentPath, compactSkillPath, manifestPath, originalManifest } =
    input;

  const workflowAgent = readJson(files, workflowAgentPath);
  const standaloneSkill = readJson(files, compactSkillPath);
  expect(workflowAgent.aiAgentEntity).toMatchObject({
    version: 19,
    properties: {
      instructions: content.get(workflowAgentId),
      leaveAlone: true,
    },
  });
  expect(workflowAgent.skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        skillEntity: {
          id: firstSkillId,
          version: 4,
          properties: { skill: content.get(firstSkillName) },
        },
      }),
    ]),
  );
  assertPlannerName(files);
  expect(standaloneSkill).toMatchObject({
    version: 4,
    properties: { skill: content.get(firstSkillName) },
  });
  expect(read(files, compactSkillPath)).toContain('"tags": ["keep compact formatting"]');
  expect(read(files, manifestPath)).toBe(originalManifest);
}

function assertPlannerName(files: Files) {
  const planner = readJson(files, `${assetRoot}/ai_agent/${plannerAgentId}.json`);
  expect(planner).toMatchObject({
    aiAgentEntity: {
      properties: {
        instructions:
          "---\nname: ai-fde-solution-planner\ndescription: source header\n---\n# New planner body\n",
      },
    },
  });
}

test("JSON patch rejects values that cannot survive JSON serialization", () => {
  const files = { "asset.json": '{"version":1}' };
  expect(() => writeAssetJson(files, "asset.json", { version: Number.NaN })).toThrow(
    "JSON patch did not produce the intended value",
  );
  expect(files["asset.json"]).toBe('{"version":1}');
});

test("asset request rejects malformed identities, paths and options", () => {
  const input = {
    repository: "/fixture/uacode",
    assets: [{ assetClass: "WORKFLOW_DEFINITION", assetId: "fixture" }],
  };

  expect(requestSchema["~standard"].validate(input).value?.feature).toBe("ai-agents");

  for (const invalid of [
    { assets: [] },
    { assets: [{ assetClass: "", assetId: "a" }] },
    { dryRun: "false" },
    { indexPath: "../escape.json" },
    { feature: "../escape" },
    { typo: true },
    { repository: "relative" },
  ]) {
    expect(requestSchema["~standard"].validate({ ...input, ...invalid }).issues).toHaveLength(1);
  }
});
