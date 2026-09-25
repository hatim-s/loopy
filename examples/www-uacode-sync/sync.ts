import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const ASSET_ROOT = "configs/platform-features/ai-agents/asset-repository";
const MANIFEST_ROOT = "configs/platform-features/ai-agents/platform/ai-sdlc";
const workflowAgentId = "e_6aa19955aeb9ea1371af57c7";

const agents = [
  {
    source: ".claude/agents/workflow-agent.md",
    id: "e_6aa19955aeb9ea1371af57c7",
    manifest: "text-to-workflow-assets.json",
  },
  {
    source: ".claude/agents/solution-planner.md",
    id: "e_6a801aea757839657bbec2a1",
    manifest: "solution-builder-assets.json",
  },
  { source: ".claude/agents/ai-fde.md", id: "e_ai_fde_agent", manifest: "ai-fde-assets.json" },
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

type Options = {
  sourceRepo?: string;
  targetRepo?: string;
  patchDir?: string;
  sourceRef: string;
  targetBranches: string[];
  dryRun: boolean;
};
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireObject(value: JsonValue | undefined, location: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Expected JSON object at ${location}`);
  return value;
}
function requireString(value: JsonValue | undefined, location: string): string {
  if (typeof value !== "string") throw new Error(`Expected string at ${location}`);
  return value;
}
function requiredContent(content: Map<string, string>, key: string): string {
  const value = content.get(key);
  if (value === undefined) throw new Error(`Source content is missing ${key}`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`Expected --option value, got '${key ?? ""}'`);
    const option = key.slice(2);
    if (
      !new Set([
        "source-repo",
        "target-repo",
        "source-ref",
        "target-branches",
        "dry-run",
        "patch-dir",
      ]).has(option)
    ) {
      throw new Error(`Unknown option '${key}'`);
    }
    values.set(option, value);
    i += 1;
  }
  const sourceRepo = values.get("source-repo");
  const targetRepo = values.get("target-repo");
  const patchDir = values.get("patch-dir");
  if (Boolean(sourceRepo) !== Boolean(targetRepo))
    throw new Error("Pass both --source-repo and --target-repo for local fixture mode");
  const dryRunValue = values.get("dry-run") ?? "true";
  if (!["true", "false"].includes(dryRunValue)) throw new Error("--dry-run must be true or false");
  return {
    ...(sourceRepo ? { sourceRepo } : {}),
    ...(targetRepo ? { targetRepo } : {}),
    ...(patchDir ? { patchDir } : {}),
    sourceRef: values.get("source-ref") ?? "main",
    targetBranches: (values.get("target-branches") ?? "main,uat").split(",").filter(Boolean),
    dryRun: dryRunValue === "true",
  };
}

function run(
  program: string,
  args: string[],
  cwd?: string,
  timeoutMs = 45_000,
  trimOutput = true,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = stdout.join("");
      const errors = stderr.join("");
      code === 0
        ? resolvePromise(trimOutput ? output.trim() : output)
        : reject(new Error(`${program} ${args[0] ?? ""} failed (${code}): ${errors.trim()}`));
    });
  });
}

async function git(cwd: string, ...args: string[]) {
  return run("git", args, cwd);
}
async function writePatch(checkout: string, branch: string, patchDir: string | undefined) {
  if (!patchDir) return;
  const output = resolve(patchDir);
  await mkdir(output, { recursive: true });
  const patch = await git(checkout, "diff", "--binary", "--", ...targetFiles);
  await writeFile(join(output, `${branch.replaceAll("/", "-")}.patch`), patch ? `${patch}\n` : "");
}
async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}
function skipSpace(text: string, start: number): number {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function stringEnd(text: string, start: number): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") cursor += 2;
    else if (text[cursor++] === '"') return cursor;
  }
  throw new Error("Malformed JSON string");
}

function jsonSpans(text: string): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  function value(start: number, path: (string | number)[]): number {
    const cursor = skipSpace(text, start);
    const first = text[cursor];
    if (first === "{") {
      let next = skipSpace(text, cursor + 1);
      while (text[next] !== "}") {
        const keyEnd = stringEnd(text, next);
        const key = JSON.parse(text.slice(next, keyEnd)) as string;
        next = skipSpace(text, keyEnd);
        if (text[next++] !== ":") throw new Error("Malformed JSON object");
        next = value(next, [...path, key]);
        next = skipSpace(text, next);
        if (text[next] === ",") next = skipSpace(text, next + 1);
        else if (text[next] !== "}") throw new Error("Malformed JSON object");
      }
      spans.set(JSON.stringify(path), [cursor, next + 1]);
      return next + 1;
    }
    if (first === "[") {
      let next = skipSpace(text, cursor + 1);
      let index = 0;
      while (text[next] !== "]") {
        next = value(next, [...path, index++]);
        next = skipSpace(text, next);
        if (text[next] === ",") next = skipSpace(text, next + 1);
        else if (text[next] !== "]") throw new Error("Malformed JSON array");
      }
      spans.set(JSON.stringify(path), [cursor, next + 1]);
      return next + 1;
    }
    const end =
      first === '"'
        ? stringEnd(text, cursor)
        : (() => {
            let next = cursor;
            while (next < text.length && !/[\s,}\]]/.test(text.charAt(next))) next += 1;
            return next;
          })();
    spans.set(JSON.stringify(path), [cursor, end]);
    return end;
  }
  const end = value(0, []);
  if (skipSpace(text, end) !== text.length) throw new Error("Trailing content after JSON value");
  return spans;
}

async function writeJsonPreserving(path: string, nextValue: JsonObject) {
  const original = await readFile(path, "utf8");
  const current = JSON.parse(original) as JsonValue;
  const spans = jsonSpans(original);
  const replacements: { start: number; end: number; text: string }[] = [];
  function compare(before: JsonValue, after: JsonValue, pathParts: (string | number)[]) {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      for (const [index, item] of before.entries())
        compare(item, after[index] ?? null, [...pathParts, index]);
      return;
    }
    if (isJsonObject(before) && isJsonObject(after)) {
      const beforeKeys = Object.keys(before);
      if (
        beforeKeys.length !== Object.keys(after).length ||
        beforeKeys.some((key) => !(key in after))
      )
        throw new Error(`Refusing to reformat existing JSON structure in ${path}`);
      for (const key of beforeKeys)
        compare(before[key] ?? null, after[key] ?? null, [...pathParts, key]);
      return;
    }
    const span = spans.get(JSON.stringify(pathParts));
    if (!span || (after !== null && typeof after === "object"))
      throw new Error(`Cannot target JSON value at ${pathParts.join(".")} in ${path}`);
    replacements.push({ start: span[0], end: span[1], text: JSON.stringify(after) ?? "null" });
  }
  compare(current, nextValue, []);
  let patched = original;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    patched = `${patched.slice(0, replacement.start)}${replacement.text}${patched.slice(replacement.end)}`;
  JSON.parse(patched);
  await writeFile(path, patched);
}

async function appendJsonArray(
  path: string,
  targetPath: (string | number)[],
  entries: JsonObject[],
): Promise<boolean> {
  const original = await readFile(path, "utf8");
  let target: JsonValue = JSON.parse(original) as JsonValue;
  for (const part of targetPath) {
    target = Array.isArray(target)
      ? (target[Number(part)] ?? null)
      : isJsonObject(target)
        ? (target[String(part)] ?? null)
        : null;
  }
  if (!Array.isArray(target))
    throw new Error(`Expected registration array at ${targetPath.join(".")} in ${path}`);
  const missing = entries.filter(
    (entry) =>
      !target.some((current) => isJsonObject(current) && current.assetId === entry.assetId),
  );
  if (!missing.length) return false;
  const span = jsonSpans(original).get(JSON.stringify(targetPath));
  if (!span)
    throw new Error(`Could not locate registration array at ${targetPath.join(".")} in ${path}`);
  const [start, end] = span;
  let trailingStart = end - 1;
  while (trailingStart > start && /\s/.test(original.charAt(trailingStart - 1))) trailingStart -= 1;
  const inner = original.slice(start + 1, trailingStart);
  const lineStart = original.lastIndexOf("\n", start) + 1;
  const parentIndent = original.slice(lineStart, start).match(/^\s*/)?.[0] ?? "";
  const childIndent = `${parentIndent}  `;
  const formatted = missing
    .map(
      (entry) =>
        `${childIndent}${JSON.stringify(entry, null, 2).replace(/\n/g, `\n${childIndent}`)}`,
    )
    .join(",\n");
  const addition = inner.trim() ? `,\n${formatted}` : `\n${formatted}`;
  const patched = `${original.slice(0, trailingStart)}${addition}${original.slice(trailingStart)}`;
  JSON.parse(patched);
  await writeFile(path, patched);
  return true;
}

function assertWithin(root: string, path: string) {
  const relative = resolve(path).slice(resolve(root).length);
  if (relative === resolve(path) || !(relative.startsWith(sep) || relative === ""))
    throw new Error(`Path escaped checkout: ${path}`);
}

export function sourceText(text: string, stripMaintainerComment = false): string {
  if (!stripMaintainerComment) return text.replace(/\r\n/g, "\n");
  const normalized = text.replace(/\r\n/g, "\n");
  const marker = "\n\n<!--\nMAINTAINER NOTE";
  const start = normalized.indexOf(marker);
  if (start < 0) return normalized;
  if (normalized.indexOf("-->", start) < 0)
    throw new Error("Canonical prompt is missing its maintainer-note block");
  const end = normalized.indexOf("-->", start) + 3;
  return `${normalized.slice(0, start)}${normalized.slice(end).replace(/^\n+/, "\n\n")}`;
}

export function shouldUpdateSyncBranch(existingTreeSha: string, desiredTreeSha: string): boolean {
  return existingTreeSha !== desiredTreeSha;
}

function mergeAgentInstructions(existing: string, source: string): string {
  const frontmatter = /^---\n[\s\S]*?\n---\n/;
  const sourceHeader = source.match(frontmatter)?.[0] ?? "";
  if (!sourceHeader) return source;
  const existingHeader = existing.match(frontmatter)?.[0] ?? sourceHeader;
  const sourceName = sourceHeader.match(/^name:\s*(.+)$/m)?.[1];
  const existingName = existingHeader.match(/^name:\s*(.+)$/m)?.[1];
  if (!sourceName || !existingName) throw new Error("Agent frontmatter must include a name field");
  const mergedHeader = sourceHeader.replace(/^name:\s*.+$/m, `name: ${existingName}`);
  return `${mergedHeader}${source.slice(sourceHeader.length)}`;
}

async function sourceContents(repo: string) {
  const result = new Map<string, string>();
  const rawCanonical = sourceText(
    await readFile(join(repo, "packages/uac/docs/agent-prompt.md"), "utf8"),
  );
  const canonical = sourceText(rawCanonical, true);
  const generatedAgent = await readFile(join(repo, ".claude/agents/workflow-agent.md"), "utf8");
  const begin = "<!-- BEGIN agent-prompt.md — generated, do not edit below this line -->";
  const end = "<!-- END agent-prompt.md -->";
  const beginIndex = generatedAgent.indexOf(begin);
  const endIndex = generatedAgent.indexOf(end, beginIndex + begin.length);
  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    generatedAgent.slice(beginIndex + begin.length, endIndex).trim() !== rawCanonical.trim()
  ) {
    throw new Error(
      ".claude/agents/workflow-agent.md is out of sync with packages/uac/docs/agent-prompt.md",
    );
  }
  result.set(workflowAgentId, canonical);
  for (const agent of agents.slice(1))
    result.set(agent.id, sourceText(await readFile(join(repo, agent.source), "utf8")));
  for (const [name] of skills) {
    result.set(
      name,
      sourceText(await readFile(join(repo, "packages/uac/skills", name, "SKILL.md"), "utf8")),
    );
  }
  return result;
}

export async function applyAssetSync(
  checkout: string,
  content: Map<string, string>,
): Promise<string[]> {
  const changed: string[] = [];

  for (const agent of agents) {
    const file = join(checkout, ASSET_ROOT, "ai_agent", `${agent.id}.json`);
    assertWithin(checkout, file);
    const asset = await readJson(file);
    const entity = requireObject(asset.aiAgentEntity, `${file}.aiAgentEntity`);
    const properties = requireObject(entity.properties, `${file}.aiAgentEntity.properties`);
    const instructions = requireString(properties.instructions, `${file}.instructions`);
    const next = mergeAgentInstructions(instructions, requiredContent(content, agent.id));
    if (instructions !== next) {
      properties.instructions = next;
      await writeJsonPreserving(file, asset);
      changed.push(file.slice(checkout.length + 1));
    }
  }

  for (const [name, id] of skills) {
    const file = join(checkout, ASSET_ROOT, "e_skill_ai_agent", `${id}.json`);
    assertWithin(checkout, file);
    const asset = await readJson(file);
    const properties = requireObject(asset.properties, `${file}.properties`);
    const currentSkill = requireString(properties.skill, `${file}.properties.skill`);
    const next = requiredContent(content, name);
    if (currentSkill !== next) {
      properties.skill = next;
      await writeJsonPreserving(file, asset);
      changed.push(file.slice(checkout.length + 1));
    }
  }

  const workflowAgentFile = join(
    checkout,
    ASSET_ROOT,
    "ai_agent",
    "e_6aa19955aeb9ea1371af57c7.json",
  );
  const workflowAgent = await readJson(workflowAgentFile);
  const embedded = workflowAgent.skills;
  if (!Array.isArray(embedded))
    throw new Error(`Workflow Agent asset has no skills array: ${workflowAgentFile}`);
  for (const [name, id] of skills.slice(0, 9)) {
    const match = embedded
      .map((item) => requireObject(item, `${workflowAgentFile}.skills[]`))
      .find((item) => {
        const entity = item.skillEntity;
        return isJsonObject(entity) && entity.id === id;
      });
    if (!match) throw new Error(`Workflow Agent is missing embedded skill ${id}`);
    const embeddedEntity = requireObject(
      match.skillEntity,
      `${workflowAgentFile}.skills.${id}.skillEntity`,
    );
    const embeddedProperties = requireObject(
      embeddedEntity.properties,
      `${workflowAgentFile}.skills.${id}.properties`,
    );
    const skill = requiredContent(content, name);
    const standalone = await readJson(join(checkout, ASSET_ROOT, "e_skill_ai_agent", `${id}.json`));
    if (standalone.version !== embeddedEntity.version)
      throw new Error(`Standalone and embedded skill versions differ for ${id}`);
    if (embeddedProperties.skill !== skill) {
      embeddedProperties.skill = skill;
      if (!changed.includes(workflowAgentFile.slice(checkout.length + 1)))
        changed.push(workflowAgentFile.slice(checkout.length + 1));
    }
  }
  if (changed.includes(workflowAgentFile.slice(checkout.length + 1)))
    await writeJsonPreserving(workflowAgentFile, workflowAgent);

  for (const agent of agents) {
    const file = join(checkout, MANIFEST_ROOT, agent.manifest);
    const manifest = await readJson(file);
    const manifestDetails = requireObject(
      manifest.assetClassVsAssetDetails,
      `${file}.assetClassVsAssetDetails`,
    );
    const entries = manifestDetails.ai_agent;
    if (!Array.isArray(entries)) throw new Error(`Manifest has no ai_agent entries: ${file}`);
    const matches = entries.filter((entry) => isJsonObject(entry) && entry.assetId === agent.id);
    if (matches.length > 1)
      throw new Error(`Manifest has duplicate agent registration ${agent.id}: ${file}`);
    if (!matches.length) {
      const assetName =
        agent.id === "e_6aa19955aeb9ea1371af57c7"
          ? "Workflow Agent"
          : agent.id === "e_6a801aea757839657bbec2a1"
            ? "Solution Planner"
            : "AI FDE";
      if (
        await appendJsonArray(
          file,
          ["assetClassVsAssetDetails", "ai_agent"],
          [{ assetClass: "ai_agent", assetId: agent.id, assetName }],
        )
      )
        changed.push(file.slice(checkout.length + 1));
    }
  }

  const skillManifestFile = join(checkout, MANIFEST_ROOT, "text-to-workflow-assets.json");
  const skillManifest = await readJson(skillManifestFile);
  const skillDetails = requireObject(
    skillManifest.assetClassVsAssetDetails,
    `${skillManifestFile}.assetClassVsAssetDetails`,
  );
  const skillEntries = skillDetails.e_skill_ai_agent;
  if (!Array.isArray(skillEntries))
    throw new Error(`Manifest has no e_skill_ai_agent entries: ${skillManifestFile}`);
  for (const [, id] of skills) {
    const matches = skillEntries.filter((entry) => isJsonObject(entry) && entry.assetId === id);
    if (matches.length > 1)
      throw new Error(`Manifest has duplicate skill registration ${id}: ${skillManifestFile}`);
    if (
      !matches.length &&
      (await appendJsonArray(
        skillManifestFile,
        ["assetClassVsAssetDetails", "e_skill_ai_agent"],
        [{ assetClass: "e_skill_ai_agent", assetId: id }],
      ))
    ) {
      changed.push(skillManifestFile.slice(checkout.length + 1));
      skillEntries.push({ assetClass: "e_skill_ai_agent", assetId: id });
    }
  }

  return changed;
}

export async function syncCheckout(
  checkout: string,
  branch: string,
  content: Map<string, string>,
  options: Options,
  sourceSha: string,
) {
  await git(checkout, "fetch", "origin", branch);
  const base = await git(checkout, "rev-parse", "FETCH_HEAD");
  const branchName = `chore/www-agent-assets-${sourceSha.slice(0, 8)}-${branch.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  await git(checkout, "checkout", "-B", branchName, base);
  await applyAssetSync(checkout, content);
  await writePatch(checkout, branch, options.patchDir);

  const status = await git(checkout, "status", "--porcelain");
  if (!status) return { branch, branchName, base, changed: [], pullRequest: null };
  await git(checkout, "diff", "--check");
  const paths = (await git(checkout, "diff", "--name-only")).split("\n").filter(Boolean);
  if (paths.some((path) => !allowedPaths.has(path)))
    throw new Error(`Sync attempted to change an unapproved path on ${branch}`);
  if (options.dryRun) return { branch, branchName, base, changed: paths, pullRequest: null };

  await git(checkout, "add", ...paths);
  await git(checkout, "commit", "-m", `Sync www agent assets from ${sourceSha.slice(0, 12)}`);
  await git(checkout, "push", "--set-upstream", "origin", branchName);
  const existing = await run("gh", [
    "pr",
    "list",
    "--repo",
    "unify-apps/uacode",
    "--head",
    branchName,
    "--base",
    branch,
    "--json",
    "url",
    "--jq",
    ".[0].url",
  ]);
  let pullRequest = existing || "";
  if (!pullRequest) {
    pullRequest = await run("gh", [
      "pr",
      "create",
      "--repo",
      "unify-apps/uacode",
      "--base",
      branch,
      "--head",
      branchName,
      "--title",
      `Sync www agent assets (${sourceSha.slice(0, 8)})`,
      "--body",
      `Updates agent prompts and skills from www commit ${sourceSha}.`,
    ]);
  }
  return { branch, branchName, base, changed: paths, pullRequest };
}

const targetFiles = [
  ...agents.map((agent) => `${ASSET_ROOT}/ai_agent/${agent.id}.json`),
  ...skills.map(([, id]) => `${ASSET_ROOT}/e_skill_ai_agent/${id}.json`),
  ...agents.map((agent) => `${MANIFEST_ROOT}/${agent.manifest}`),
];
const allowedPaths = new Set(targetFiles);

async function ghJson(endpoint: string, temp: string, request?: unknown): Promise<JsonObject> {
  const inputPath = join(
    temp,
    `gh-request-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  try {
    if (request !== undefined) await writeFile(inputPath, JSON.stringify(request));
    const args =
      request === undefined
        ? ["api", endpoint]
        : ["api", "--method", "POST", endpoint, "--input", inputPath];
    return JSON.parse(await run("gh", args)) as JsonObject;
  } catch (error) {
    throw new Error(`GitHub API request failed for ${endpoint}: ${String(error)}`);
  } finally {
    await rm(inputPath, { force: true });
  }
}

async function ghText(endpoint: string): Promise<string> {
  try {
    return await run(
      "gh",
      ["api", "-H", "Accept: application/vnd.github.raw+json", endpoint],
      undefined,
      45_000,
      false,
    );
  } catch (error) {
    throw new Error(`GitHub content read failed for ${endpoint}: ${String(error)}`);
  }
}

async function githubSourceContent(sourceSha: string) {
  const get = (path: string) => ghText(`repos/unify-apps/www/contents/${path}?ref=${sourceSha}`);
  const result = new Map<string, string>();
  const rawCanonical = sourceText(await get("packages/uac/docs/agent-prompt.md"));
  const canonical = sourceText(rawCanonical, true);
  const generatedAgent = sourceText(await get(".claude/agents/workflow-agent.md"));
  const begin = "<!-- BEGIN agent-prompt.md — generated, do not edit below this line -->";
  const end = "<!-- END agent-prompt.md -->";
  const beginIndex = generatedAgent.indexOf(begin);
  const endIndex = generatedAgent.indexOf(end, beginIndex + begin.length);
  if (
    beginIndex < 0 ||
    endIndex < 0 ||
    generatedAgent.slice(beginIndex + begin.length, endIndex).trim() !== rawCanonical.trim()
  ) {
    throw new Error(
      ".claude/agents/workflow-agent.md is out of sync with packages/uac/docs/agent-prompt.md at the pinned source commit",
    );
  }
  result.set(workflowAgentId, canonical);
  for (const agent of agents.slice(1)) result.set(agent.id, sourceText(await get(agent.source)));
  for (const [name] of skills)
    result.set(name, sourceText(await get(`packages/uac/skills/${name}/SKILL.md`)));
  return result;
}

async function prepareTargetFiles(baseSha: string, checkout: string) {
  await mkdir(checkout, { recursive: true });
  for (const path of targetFiles) {
    const contents = await ghText(`repos/unify-apps/uacode/contents/${path}?ref=${baseSha}`);
    const destination = join(checkout, path);
    assertWithin(checkout, destination);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  await run("git", ["init", "-q"], checkout);
  await git(checkout, "config", "user.name", "www-uacode-sync");
  await git(checkout, "config", "user.email", "www-uacode-sync@users.noreply.github.com");
  await git(checkout, "add", ...targetFiles);
  await git(checkout, "commit", "-m", "Base asset sync preview");
}

async function githubSync(
  options: Options,
  sourceSha: string,
  content: Map<string, string>,
  temp: string,
) {
  const results = [];
  for (const branch of options.targetBranches) {
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`Invalid target branch '${branch}'`);
    const encodedBranch = encodeURIComponent(branch);
    const baseRef = await ghJson(`repos/unify-apps/uacode/git/ref/heads/${encodedBranch}`, temp);
    const baseObject = requireObject(baseRef.object, `uacode ref ${branch}.object`);
    const base = requireString(baseObject.sha, `uacode ref ${branch}.object.sha`);
    const checkout = join(temp, `uacode-${branch.replaceAll("/", "-")}`);
    await prepareTargetFiles(base, checkout);
    await applyAssetSync(checkout, content);
    await writePatch(checkout, branch, options.patchDir);
    await git(checkout, "diff", "--check", "--", ...targetFiles);
    const paths = (await git(checkout, "diff", "--name-only", "--", ...targetFiles))
      .split("\n")
      .filter(Boolean);
    if (paths.some((path) => !allowedPaths.has(path)))
      throw new Error(`Sync attempted to change an unapproved path on ${branch}`);
    const branchName = `chore/www-agent-assets-${sourceSha.slice(0, 8)}-${branch.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    if (!paths.length || options.dryRun) {
      results.push({ branch, branchName, base, changed: paths, pullRequest: null });
      continue;
    }
    const existing = await run("gh", [
      "pr",
      "list",
      "--repo",
      "unify-apps/uacode",
      "--head",
      branchName,
      "--base",
      branch,
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ]);
    const baseCommit = await ghJson(`repos/unify-apps/uacode/git/commits/${base}`, temp);
    const baseTree = requireObject(baseCommit.tree, `uacode commit ${base}.tree`);
    const tree = [];
    for (const path of paths)
      tree.push({
        path,
        mode: "100644",
        type: "blob",
        content: await readFile(join(checkout, path), "utf8"),
      });
    const createdTree = await ghJson("repos/unify-apps/uacode/git/trees", temp, {
      base_tree: requireString(baseTree.sha, `uacode commit ${base}.tree.sha`),
      tree,
    });
    const createdTreeSha = requireString(createdTree.sha, "created Git tree SHA");
    if (existing) {
      const syncBranch = `chore/www-agent-assets-${sourceSha.slice(0, 8)}-${branch.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      const syncRef = await ghJson(
        `repos/unify-apps/uacode/git/ref/heads/${encodeURIComponent(syncBranch)}`,
        temp,
      );
      const syncRefObject = requireObject(syncRef.object, `sync branch ${syncBranch}.object`);
      const existingCommitSha = requireString(
        syncRefObject.sha,
        `sync branch ${syncBranch}.object.sha`,
      );
      const existingCommit = await ghJson(
        `repos/unify-apps/uacode/git/commits/${existingCommitSha}`,
        temp,
      );
      const existingTree = requireObject(
        existingCommit.tree,
        `sync commit ${existingCommitSha}.tree`,
      );
      const existingTreeSha = requireString(
        existingTree.sha,
        `sync commit ${existingCommitSha}.tree.sha`,
      );
      if (!shouldUpdateSyncBranch(existingTreeSha, createdTreeSha)) {
        results.push({
          branch,
          branchName,
          base,
          changed: paths,
          pullRequest: existing,
          branchUpdated: false,
        });
        continue;
      }
    }
    const commit = await ghJson("repos/unify-apps/uacode/git/commits", temp, {
      message: `Sync www agent assets from ${sourceSha.slice(0, 12)}`,
      tree: createdTreeSha,
      parents: [base],
    });
    const commitSha = requireString(commit.sha, "created Git commit SHA");
    const syncRef = `refs/heads/${branchName}`;
    const encodedSyncBranch = encodeURIComponent(branchName);
    let existingRef = false;
    try {
      await ghJson(`repos/unify-apps/uacode/git/ref/heads/${encodedSyncBranch}`, temp);
      existingRef = true;
    } catch (error) {
      if (!String(error).includes("HTTP 404") && !String(error).includes("Not Found")) throw error;
    }
    const refPath = join(temp, `gh-ref-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      await writeFile(
        refPath,
        JSON.stringify({
          sha: commitSha,
          ...(existingRef ? { force: true } : {}),
          ...(!existingRef ? { ref: syncRef } : {}),
        }),
      );
      const endpoint = existingRef
        ? `repos/unify-apps/uacode/git/refs/heads/${encodedSyncBranch}`
        : "repos/unify-apps/uacode/git/refs";
      const method = existingRef ? "PATCH" : "POST";
      await run("gh", ["api", "--method", method, endpoint, "--input", refPath]);
    } finally {
      await rm(refPath, { force: true });
    }
    const pullRequest =
      existing ||
      (await run("gh", [
        "pr",
        "create",
        "--repo",
        "unify-apps/uacode",
        "--base",
        branch,
        "--head",
        branchName,
        "--title",
        `Sync www agent assets (${sourceSha.slice(0, 8)})`,
        "--body-file",
        await writePullRequestBody(temp, sourceSha, base, paths),
      ]));
    if (existing) {
      const bodyFile = await writePullRequestBody(temp, sourceSha, base, paths);
      try {
        await run("gh", [
          "pr",
          "edit",
          existing,
          "--repo",
          "unify-apps/uacode",
          "--body-file",
          bodyFile,
        ]);
      } finally {
        await rm(bodyFile, { force: true });
      }
    }
    results.push({ branch, branchName, base, changed: paths, pullRequest });
  }
  return results;
}

async function writePullRequestBody(
  temp: string,
  sourceSha: string,
  baseSha: string,
  paths: string[],
) {
  const bodyPath = join(
    temp,
    `pull-request-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  const body = [
    `Syncs www source commit ${sourceSha} into uacode base ${baseSha}.`,
    "",
    "Run mode: apply. Diff validation passed before commit creation (`git diff --check`).",
    "",
    "Changed paths:",
    ...paths.map((path) => `- \`${path}\``),
  ].join("\n");
  await writeFile(bodyPath, body);
  return bodyPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const temporary = await mkdtemp(join(tmpdir(), "www-uacode-sync-"));
  try {
    let sourceSha: string;
    let results: unknown[];
    if (!options.sourceRepo || !options.targetRepo) {
      const sourceRef = await ghJson(
        `repos/unify-apps/www/git/ref/heads/${encodeURIComponent(options.sourceRef)}`,
        temporary,
      );
      const sourceObject = requireObject(sourceRef.object, `www ref ${options.sourceRef}.object`);
      sourceSha = requireString(sourceObject.sha, `www ref ${options.sourceRef}.object.sha`);
      const content = await githubSourceContent(sourceSha);
      results = await githubSync(options, sourceSha, content, temporary);
    } else {
      const sourcePath = resolve(options.sourceRepo);
      const targetPath = resolve(options.targetRepo);
      const sourceOrigin = await git(sourcePath, "remote", "get-url", "origin");
      const targetOrigin = await git(targetPath, "remote", "get-url", "origin");
      if (
        !options.dryRun &&
        (!sourceOrigin.includes("unify-apps/www.git") ||
          !targetOrigin.includes("unify-apps/uacode.git"))
      ) {
        throw new Error("Local apply mode requires the expected www and uacode origins");
      }
      const source = join(temporary, "www");
      await run("git", ["clone", "--no-checkout", options.sourceRepo, source]);
      await git(source, "fetch", "origin", options.sourceRef);
      sourceSha = await git(source, "rev-parse", "FETCH_HEAD");
      await git(source, "checkout", "--detach", sourceSha);
      const content = await sourceContents(source);
      results = [];
      for (const branch of options.targetBranches) {
        if (!/^[A-Za-z0-9._/-]+$/.test(branch))
          throw new Error(`Invalid target branch '${branch}'`);
        const checkout = join(temporary, `uacode-${branch.replaceAll("/", "-")}`);
        await run("git", ["clone", "--no-checkout", options.targetRepo, checkout]);
        results.push(await syncCheckout(checkout, branch, content, options, sourceSha));
      }
    }
    console.log(JSON.stringify({ sourceSha, dryRun: options.dryRun, results }, null, 2));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
