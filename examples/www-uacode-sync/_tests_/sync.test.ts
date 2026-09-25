import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAssetSync, selectSyncPullRequest, shouldUpdateSyncBranch, sourceText } from "../sync";

const root = "/tmp/www-uacode-sync-core-test";
const assetRoot = "configs/platform-features/ai-agents/asset-repository";
const agentIds = ["e_6aa19955aeb9ea1371af57c7", "e_6a801aea757839657bbec2a1", "e_ai_fde_agent"];
const workflowAgentId = "e_6aa19955aeb9ea1371af57c7";
const plannerAgentId = "e_6a801aea757839657bbec2a1";
const firstSkillName = "external-data-inspection";
const firstSkillId = "e_6ab1053b200bf5533fd0ad0b";
const lastSkillId = "e_6a5f2c12f62c9924bb176689";
const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
const releasePath = join(root, assetRoot, "ENTITY_TYPE/ai_sdlc_feature_release.jsonl");
const skills = [
  ["external-data-inspection", "e_6ab1053b200bf5533fd0ad0b"],
  ["automation-run-debugging", "e_6aa851442b4d71304f6477b1"],
  ["resiliency", "e_6aa801afd4d5060ea2c2ae6c"],
  ["unifyapps-data", "e_6aa7bd94c5f3d07089a31e0f"],
  ["dates-and-time", "e_6aa597e7925f613bb83a93e0"],
  ["data-transforms-and-code", "e_6aa575ddf957a5242c28bb10"],
  ["node-inputs-and-pills", "e_6aa5718b925f613bb83a2a29"],
  ["files-and-attachments", "e_6a6799038166536c4740ae9f"],
  ["performance", "e_6a5f2c12f62c9924bb176689"],
] as const;

async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function makeFixture(versionMismatch = false) {
  const content = new Map<string, string>();
  const embeddedSkills = skills.slice(0, 9).map(([name, id]) => ({
    skillEntity: {
      id,
      version: id === firstSkillId && versionMismatch ? 2 : 4,
      properties: { skill: `old ${name}` },
    },
  }));
  for (const id of agentIds) {
    const prompt =
      id === agentIds[1]
        ? "---\nname: Solution Planner\ndescription: source header\n---\n# New planner body\n"
        : `new ${id}`;
    content.set(id, prompt);
    await writeJson(join(root, assetRoot, "ai_agent", `${id}.json`), {
      aiAgentEntity: {
        version: 19,
        properties: {
          instructions:
            id === agentIds[1]
              ? "---\nname: ai-fde-solution-planner\ndescription: asset header\n---\nold body\n"
              : `old ${id}`,
          leaveAlone: true,
        },
      },
      skills: id === agentIds[0] ? embeddedSkills : [],
      name: "preserve this field",
    });
  }
  for (const [name, id] of skills) {
    content.set(name, `new ${name}`);
    await writeJson(join(root, assetRoot, "e_skill_ai_agent", `${id}.json`), {
      properties: { skill: `old ${name}`, enabled: true },
      standard: true,
      tags: ["keep compact formatting"],
      version: 4,
    });
    if (name === firstSkillName) {
      const path = join(root, assetRoot, "e_skill_ai_agent", `${id}.json`);
      const json = await readFile(path, "utf8");
      await writeFile(
        path,
        json.replace(
          '"tags": [\n    "keep compact formatting"\n  ]',
          '"tags": ["keep compact formatting"]',
        ),
      );
    }
  }
  const manifestRoot = join(root, "configs/platform-features/ai-agents/platform/ai-sdlc");
  await writeJson(join(manifestRoot, "text-to-workflow-assets.json"), {
    assetClassVsAssetDetails: {
      ai_agent: [{ assetClass: "ai_agent", assetId: agentIds[0], assetName: "Workflow Agent" }],
      e_skill_ai_agent: skills.map(([, id]) => ({ assetClass: "e_skill_ai_agent", assetId: id })),
    },
  });
  await writeJson(join(manifestRoot, "solution-builder-assets.json"), {
    assetClassVsAssetDetails: {
      ai_agent: agentIds.slice(1).map((id) => ({ assetClass: "ai_agent", assetId: id })),
    },
  });
  await writeJson(join(manifestRoot, "ai-fde-assets.json"), {
    assetClassVsAssetDetails: { ai_agent: [{ assetClass: "ai_agent", assetId: agentIds[2] }] },
  });
  await mkdir(join(root, assetRoot, "ENTITY_TYPE"), { recursive: true });
  await writeFile(
    releasePath,
    `${[
      { properties: { featureId: "ai-fde", version: "1.1.29", message: "old" } },
      { properties: { featureId: "solution-builder", version: "2.4.19", message: "old" } },
      { properties: { featureId: "text-to-workflow", version: "3.0.17", message: "old" } },
      { properties: { featureId: "unrelated", version: "1.2.3", message: "preserve" } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  return content;
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("www to uacode asset mapping", () => {
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

  test("keeps an existing sync branch when its full tree already matches the desired tree", () => {
    expect(shouldUpdateSyncBranch("tree-abc", "tree-abc")).toBe(false);
    expect(shouldUpdateSyncBranch("tree-old", "tree-new")).toBe(true);
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
    expect(selectSyncPullRequest(candidates, "main")).toEqual(candidates[0]);
    expect(selectSyncPullRequest(candidates, "uat")).toEqual(candidates[2]);
    expect(selectSyncPullRequest(candidates, "release/1")).toBeUndefined();
    expect(() =>
      selectSyncPullRequest(
        [mainCandidate, { ...mainCandidate, headRefName: "chore/www-agent-assets-550febe0-main" }],
        "main",
      ),
    ).toThrow("multiple open www asset sync PRs for base main");
  });

  test("updates registered skill copies once and preserves export metadata and JSON layout", async () => {
    const content = await makeFixture();
    const workflowAgentPath = join(root, assetRoot, "ai_agent", `${agentIds[0]}.json`);
    const compactSkillPath = join(root, assetRoot, "e_skill_ai_agent", `${firstSkillId}.json`);
    const originalManifest = await readFile(
      join(
        root,
        "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
      ),
      "utf8",
    );
    const manifestPath = join(
      root,
      "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
    );

    const firstChanges = await applyAssetSync(root, content, sourceSha);
    const secondChanges = await applyAssetSync(root, content, sourceSha);
    const workflowAgent = JSON.parse(await readFile(workflowAgentPath, "utf8"));
    const standaloneSkill = JSON.parse(await readFile(compactSkillPath, "utf8"));
    const embedded = workflowAgent.skills[0].skillEntity;
    const skillRaw = await readFile(compactSkillPath, "utf8");

    expect(firstChanges).toHaveLength(13);
    expect(secondChanges).toEqual([]);
    expect(workflowAgent.aiAgentEntity.properties.instructions).toBe(content.get(workflowAgentId));
    expect(workflowAgent.aiAgentEntity.version).toBe(19);
    expect(workflowAgent.aiAgentEntity.properties.leaveAlone).toBe(true);
    const planner = JSON.parse(
      await readFile(join(root, assetRoot, "ai_agent", `${plannerAgentId}.json`), "utf8"),
    );
    expect(planner.aiAgentEntity.properties.instructions).toBe(
      "---\nname: ai-fde-solution-planner\ndescription: source header\n---\n# New planner body\n",
    );
    expect(embedded.properties.skill).toBe(content.get(firstSkillName));
    expect(embedded.version).toBe(4);
    expect(standaloneSkill.properties.skill).toBe(content.get(firstSkillName));
    expect(standaloneSkill.version).toBe(4);
    expect(skillRaw).toContain('"tags": ["keep compact formatting"]');
    expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
    const releaseLines = (await readFile(releasePath, "utf8")).trim().split("\n");
    const releases = releaseLines.map((line) => JSON.parse(line));
    expect(releases.slice(0, 3).map((record) => record.properties.version)).toEqual([
      "1.1.30",
      "2.4.20",
      "3.0.18",
    ]);
    expect(releases.slice(0, 3).map((record) => record.properties.message)).toEqual(
      Array(3).fill(`Sync www agent prompts and skills from ${sourceSha.slice(0, 12)}`),
    );
    expect(releaseLines[3]).toBe(
      JSON.stringify({
        properties: { featureId: "unrelated", version: "1.2.3", message: "preserve" },
      }),
    );
  });

  test("bumps only the release feature affected by a later Workflow Agent change", async () => {
    const content = await makeFixture();
    await applyAssetSync(root, content, sourceSha);
    content.set(workflowAgentId, "updated Workflow Agent prompt\n");

    const changes = await applyAssetSync(root, content, sourceSha);
    const releases = (await readFile(releasePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(changes).toContain(`${assetRoot}/ai_agent/${workflowAgentId}.json`);
    expect(releases.slice(0, 3).map((record) => record.properties.version)).toEqual([
      "1.1.30",
      "2.4.20",
      "3.0.19",
    ]);
  });

  test("fails before syncing a skill whose embedded and standalone export versions disagree", async () => {
    const content = await makeFixture(true);
    await expect(applyAssetSync(root, content, sourceSha)).rejects.toThrow(
      "Standalone and embedded skill versions differ",
    );
  });

  test("adds a missing skill registration to the manifest without rewriting other registration data", async () => {
    const content = await makeFixture();
    const manifestPath = join(
      root,
      "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assetClassVsAssetDetails.e_skill_ai_agent =
      manifest.assetClassVsAssetDetails.e_skill_ai_agent.filter(
        (entry: { assetId: string }) => entry.assetId !== lastSkillId,
      );
    await writeJson(manifestPath, manifest);
    const changes = await applyAssetSync(root, content, sourceSha);
    const updated = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(changes).toContain(
      "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
    );
    expect(
      updated.assetClassVsAssetDetails.e_skill_ai_agent.map(
        (entry: { assetId: string }) => entry.assetId,
      ),
    ).toContain(lastSkillId);
    expect(updated.assetClassVsAssetDetails.ai_agent).toEqual(
      manifest.assetClassVsAssetDetails.ai_agent,
    );
  });

  test("rejects malformed asset-specific frontmatter instead of replacing its name", async () => {
    const content = await makeFixture();
    const path = join(root, assetRoot, "ai_agent", `${plannerAgentId}.json`);
    const asset = JSON.parse(await readFile(path, "utf8"));
    asset.aiAgentEntity.properties.instructions = "---\ndescription: no name\n---\nold body\n";
    await writeJson(path, asset);

    await expect(applyAssetSync(root, content, sourceSha)).rejects.toThrow(
      "Agent frontmatter must include a name field",
    );
  });
});
