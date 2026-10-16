import {
  appendRegistration,
  type Files,
  isObject,
  type JsonObject,
  parse,
  read,
  readJson,
  object as requireObject,
  string as requireString,
  writeJson,
} from "./json-edit.ts";

export type { Files } from "./json-edit.ts";

const ASSET_ROOT = "configs/platform-features/ai-agents/asset-repository";

const MANIFEST_ROOT = "configs/platform-features/ai-agents/platform/ai-sdlc";

const RELEASE_RECORDS = `${ASSET_ROOT}/ENTITY_TYPE/ai_sdlc_feature_release.jsonl`;

const workflowAgentId = "e_6aa19955aeb9ea1371af57c7";

const agents = [
  {
    source: ".claude/agents/workflow-agent.md",
    name: "Workflow Agent",
    id: "e_6aa19955aeb9ea1371af57c7",
    manifest: "text-to-workflow-assets.json",
  },
  {
    source: ".claude/agents/solution-planner.md",
    name: "Solution Planner",
    id: "e_6a801aea757839657bbec2a1",
    manifest: "solution-builder-assets.json",
  },
  {
    source: ".claude/agents/ai-fde.md",
    name: "AI FDE",
    id: "e_ai_fde_agent",
    manifest: "ai-fde-assets.json",
  },
] as const;

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

function requiredContent(content: Map<string, string>, key: string) {
  const value = content.get(key);

  if (value === undefined) {
    throw new Error(`Source content is missing ${key}. Restore the source file before retrying.`);
  }

  return value;
}

export function sourceText(text: string, stripMaintainerComment = false): string {
  if (!stripMaintainerComment) {
    return text.replace(/\r\n/g, "\n");
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const marker = "\n\n<!--\nMAINTAINER NOTE";
  const start = normalized.indexOf(marker);

  if (start < 0) {
    return normalized;
  }

  if (normalized.indexOf("-->", start) < 0) {
    throw new Error(
      "Canonical prompt is missing its maintainer-note block. Restore the closing comment before retrying.",
    );
  }

  const end = normalized.indexOf("-->", start) + 3;

  return `${normalized.slice(0, start)}${normalized.slice(end).replace(/^\n+/, "\n\n")}`;
}

function mergeAgentInstructions(existing: string, source: string): string {
  const frontmatter = /^---\n[\s\S]*?\n---\n/;
  const sourceHeader = source.match(frontmatter)?.[0] ?? "";

  if (!sourceHeader) {
    return source;
  }

  const existingHeader = existing.match(frontmatter)?.[0] ?? sourceHeader;
  const sourceName = sourceHeader.match(/^name:\s*(.+)$/m)?.[1];
  const existingName = existingHeader.match(/^name:\s*(.+)$/m)?.[1];

  if (!sourceName || !existingName) {
    throw new Error(
      "Agent frontmatter must include a name field. Restore the source and asset names before retrying.",
    );
  }

  const mergedHeader = sourceHeader.replace(/^name:\s*.+$/m, `name: ${existingName}`);

  return `${mergedHeader}${source.slice(sourceHeader.length)}`;
}

export function sourceContents(files: Files) {
  const result = new Map<string, string>();

  const rawCanonical = sourceText(read(files, "packages/uac/docs/agent-prompt.md"));

  const canonical = sourceText(rawCanonical, true);
  const generatedAgent = read(files, ".claude/agents/workflow-agent.md");
  const begin = "<!-- BEGIN agent-prompt.md \u2014 generated, do not edit below this line -->";
  const end = "<!-- END agent-prompt.md -->";
  const beginIndex = generatedAgent.indexOf(begin);
  const endIndex = generatedAgent.indexOf(end, beginIndex + begin.length);

  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    generatedAgent.slice(beginIndex + begin.length, endIndex).trim() !== rawCanonical.trim()
  ) {
    throw new Error(
      ".claude/agents/workflow-agent.md is out of sync with packages/uac/docs/agent-prompt.md. Regenerate the agent prompt before retrying.",
    );
  }

  result.set(workflowAgentId, canonical);

  for (const agent of agents.slice(1)) {
    result.set(agent.id, sourceText(read(files, agent.source)));
  }

  for (const [name] of skills) {
    result.set(name, sourceText(read(files, `packages/uac/skills/${name}/SKILL.md`)));
  }

  return result;
}

export function applyAssetSync(files: Files, content: Map<string, string>, sourceSha: string) {
  const before = { ...files };

  for (const agent of agents) {
    syncAgent(files, content, agent.id);
    appendRegistration(files, `${MANIFEST_ROOT}/${agent.manifest}`, "ai_agent", {
      assetClass: "ai_agent",
      assetId: agent.id,
      assetName: agent.name,
    });
  }

  for (const [name, id] of skills) {
    syncSkill(files, content, name, id);
    appendRegistration(files, `${MANIFEST_ROOT}/text-to-workflow-assets.json`, "e_skill_ai_agent", {
      assetClass: "e_skill_ai_agent",
      assetId: id,
    });
  }

  const changed = () => Object.keys(files).filter((path) => files[path] !== before[path]);
  bumpReleases(files, affectedFeatures(changed()), sourceSha);

  return changed();
}

function syncAgent(files: Files, content: Map<string, string>, id: string) {
  const path = `${ASSET_ROOT}/ai_agent/${id}.json`;
  const asset = readJson(files, path);
  const entity = requireObject(asset.aiAgentEntity, `${path}.aiAgentEntity`);
  const properties = requireObject(entity.properties, `${path}.properties`);
  const instructions = requireString(properties.instructions, `${path}.instructions`);
  properties.instructions = mergeAgentInstructions(instructions, requiredContent(content, id));
  writeJson(files, path, asset);
}

function syncSkill(files: Files, content: Map<string, string>, name: string, id: string) {
  const path = `${ASSET_ROOT}/e_skill_ai_agent/${id}.json`;
  const asset = readJson(files, path);
  const properties = requireObject(asset.properties, `${path}.properties`);
  requireString(properties.skill, `${path}.skill`);
  properties.skill = requiredContent(content, name);
  writeJson(files, path, asset);
  syncEmbeddedSkill(files, asset, name, id, content);
}

function syncEmbeddedSkill(
  files: Files,
  standalone: JsonObject,
  name: string,
  id: string,
  content: Map<string, string>,
) {
  const path = `${ASSET_ROOT}/ai_agent/${workflowAgentId}.json`;
  const asset = readJson(files, path);

  if (!Array.isArray(asset.skills)) {
    throw new Error(
      `Workflow Agent asset has no skills array: ${path}. Restore the exported skills before retrying.`,
    );
  }

  const match = asset.skills
    .map((item) => requireObject(item, path))
    .find((item) => isObject(item.skillEntity) && requireObject(item.skillEntity, path).id === id);

  if (!match) {
    throw new Error(
      `Workflow Agent is missing embedded skill ${id}. Restore the embedded skill before retrying.`,
    );
  }

  const entity = requireObject(match.skillEntity, path);

  if (standalone.version !== entity.version) {
    throw new Error(
      `Standalone and embedded skill versions differ for ${id}. Export matching versions before retrying.`,
    );
  }

  requireObject(entity.properties, path).skill = requiredContent(content, name);
  writeJson(files, path, asset);
}

function affectedFeatures(paths: string[]) {
  const features = new Set<string>();

  for (const path of paths) {
    const manifest = path.match(/platform\/ai-sdlc\/([\w-]+)-assets\.json$/)?.[1];

    if (manifest) {
      features.add(manifest);
    }

    if (
      path === `${ASSET_ROOT}/ai_agent/${agents[0].id}.json` ||
      skills.some(([, id]) => path === `${ASSET_ROOT}/e_skill_ai_agent/${id}.json`)
    ) {
      features.add("text-to-workflow");
    }

    if (path === `${ASSET_ROOT}/ai_agent/${agents[1].id}.json`) {
      features.add("solution-builder");
    }

    if (path === `${ASSET_ROOT}/ai_agent/${agents[2].id}.json`) {
      features.add("solution-builder");
      features.add("ai-fde");
    }
  }

  return features;
}

function bumpReleases(files: Files, features: Set<string>, sourceSha: string) {
  if (!features.size) {
    return;
  }

  const found = new Set<string>();

  const next = read(files, RELEASE_RECORDS)
    .split("\n")
    .map((line) => bumpRelease(line, features, found, sourceSha));

  const missing = [...features].filter((feature) => !found.has(feature));

  if (missing.length) {
    throw new Error(
      `Missing ai-sdlc release record(s): ${missing.join(", ")}. Restore the release records before retrying.`,
    );
  }

  files[RELEASE_RECORDS] = next.join("\n");
}

// BOUNDARY: Release JSONL fields are validated before selecting features and bumping versions.
function bumpRelease(line: string, features: Set<string>, found: Set<string>, sourceSha: string) {
  if (!line.trim()) {
    return line;
  }

  const record = requireObject(parse(line), "release record");

  const properties = isObject(record.properties)
    ? requireObject(record.properties, "release properties")
    : null;

  const feature = properties?.featureId;

  if (typeof feature !== "string" || !features.has(feature) || !properties) {
    return line;
  }

  if (found.has(feature)) {
    throw new Error(
      `Duplicate ai-sdlc release record for ${feature}. Remove duplicate records before retrying.`,
    );
  }

  found.add(feature);
  const current = requireString(properties.version, feature);
  const version = current.match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!version) {
    throw new Error(
      `Expected semver release version for ${feature}, got ${current}. Correct the release version before retrying.`,
    );
  }

  properties.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
  properties.message = `Sync www agent prompts and skills from ${sourceSha.slice(0, 12)}`;

  return JSON.stringify(record);
}

export const sourceFiles = [
  "packages/uac/docs/agent-prompt.md",
  ...agents.map((agent) => agent.source),
  ...skills.map(([name]) => `packages/uac/skills/${name}/SKILL.md`),
];

export const targetFiles = [
  ...agents.map((agent) => `${ASSET_ROOT}/ai_agent/${agent.id}.json`),
  ...skills.map(([, id]) => `${ASSET_ROOT}/e_skill_ai_agent/${id}.json`),
  ...agents.map((agent) => `${MANIFEST_ROOT}/${agent.manifest}`),
  RELEASE_RECORDS,
];

export function planSync(source: Files, target: Files, sourceSha: string) {
  const next = { ...target };

  return applyAssetSync(next, sourceContents(source), sourceSha).map((path) => ({
    path,
    contents: read(next, path),
  }));
}

export function syncCommitMessage(sourceSha: string, baseSha: string) {
  return `Sync www agent assets from ${sourceSha.slice(0, 12)}\n\nLoopy-www-source: ${sourceSha}\nLoopy-uacode-base: ${baseSha}`;
}

export function syncMetadata(message: string) {
  const source = message.match(/^Loopy-www-source: ([0-9a-f]{40})$/m)?.[1];
  const base = message.match(/^Loopy-uacode-base: ([0-9a-f]{40})$/m)?.[1];

  if (!source || !base || message.trim() !== syncCommitMessage(source, base)) {
    throw new Error(
      "Refusing to update an unrecognized sync branch commit. Review its edits manually.",
    );
  }

  return { source, base };
}

export function pullRequestBody(source: string, base: string, paths: string[]) {
  return [
    `Syncs www source commit ${source} into uacode base ${base}.`,
    "",
    "Checks: pure asset validation, git diff --check.",
    "",
    "Changed paths:",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}
