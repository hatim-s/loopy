import { join } from "node:path";
import type { Json } from "loopy";
import { type Files, read } from "../../www-uacode-sync/json-edit";

export const root = "";

export const assetRoot = "configs/platform-features/ai-agents/asset-repository";

export const agentIds = [
  "e_6aa19955aeb9ea1371af57c7",
  "e_6a801aea757839657bbec2a1",
  "e_ai_fde_agent",
] as const;

export const workflowAgentId = "e_6aa19955aeb9ea1371af57c7";

export const plannerAgentId = "e_6a801aea757839657bbec2a1";

export const firstSkillName = "external-data-inspection";

export const firstSkillId = "e_6ab1053b200bf5533fd0ad0b";

export const releasePath = join(root, assetRoot, "ENTITY_TYPE/ai_sdlc_feature_release.jsonl");

export const skills = [
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

export function writeJson(files: Files, path: string, value: Json) {
  files[path] = JSON.stringify(value, null, 2);
}

export function makeFixture(versionMismatch = false) {
  const files: Files = {};
  const content = new Map<string, string>();
  agentFixtures(files, content, versionMismatch);
  skillFixtures(files, content);
  manifestFixtures(files);
  releaseFixtures(files);

  return { content, files };
}

function agentFixtures(files: Files, content: Map<string, string>, versionMismatch: boolean) {
  const embedded = skills.map(([name, id]) => ({
    skillEntity: {
      id,
      version: id === firstSkillId && versionMismatch ? 2 : 4,
      properties: { skill: `old ${name}` },
    },
  }));

  for (const id of agentIds) {
    const prompt =
      id === plannerAgentId
        ? "---\nname: Solution Planner\ndescription: source header\n---\n# New planner body\n"
        : `new ${id}`;

    content.set(id, prompt);
    writeJson(files, `${assetRoot}/ai_agent/${id}.json`, {
      aiAgentEntity: {
        version: 19,
        properties: {
          instructions:
            id === plannerAgentId
              ? "---\nname: ai-fde-solution-planner\ndescription: asset header\n---\nold body\n"
              : `old ${id}`,
          leaveAlone: true,
        },
      },
      skills: id === workflowAgentId ? embedded : [],
      name: "preserve this field",
    });
  }
}

function skillFixtures(files: Files, content: Map<string, string>) {
  for (const [name, id] of skills) {
    content.set(name, `new ${name}`);
    const path = `${assetRoot}/e_skill_ai_agent/${id}.json`;
    writeJson(files, path, {
      properties: { skill: `old ${name}`, enabled: true },
      standard: true,
      tags: ["keep compact formatting"],
      version: 4,
    });

    if (name === firstSkillName) {
      files[path] = read(files, path).replace(
        '"tags": [\n    "keep compact formatting"\n  ]',
        '"tags": ["keep compact formatting"]',
      );
    }
  }
}

function manifestFixtures(files: Files) {
  const manifestRoot = join(root, "configs/platform-features/ai-agents/platform/ai-sdlc");
  writeJson(files, join(manifestRoot, "text-to-workflow-assets.json"), {
    assetClassVsAssetDetails: {
      ai_agent: [{ assetClass: "ai_agent", assetId: agentIds[0], assetName: "Workflow Agent" }],
      e_skill_ai_agent: skills.map(([, id]) => ({ assetClass: "e_skill_ai_agent", assetId: id })),
    },
  });
  writeJson(files, join(manifestRoot, "solution-builder-assets.json"), {
    assetClassVsAssetDetails: {
      ai_agent: agentIds.slice(1).map((id) => ({ assetClass: "ai_agent", assetId: id })),
    },
  });
  writeJson(files, join(manifestRoot, "ai-fde-assets.json"), {
    assetClassVsAssetDetails: { ai_agent: [{ assetClass: "ai_agent", assetId: agentIds[2] }] },
  });
}

function releaseFixtures(files: Files) {
  writeFile(
    files,
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
}

function writeFile(files: Files, path: string, value: string) {
  files[path] = value;
}
