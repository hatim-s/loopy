import { isAbsolute } from "node:path";

export function validateInput(input: {
  repository: string;
  dryRun: boolean;
  sourceRef?: string;
  targetBranches?: string;
}) {
  if (!isAbsolute(input.repository)) {
    throw new Error("Repository must be an absolute path. Supply the full checkout root.");
  }

  const sourceRef = input.sourceRef ?? "main";
  const targetBranches = (input.targetBranches ?? "main,uat").split(",");

  if (
    !targetBranches.length ||
    new Set(targetBranches).size !== targetBranches.length ||
    [sourceRef, ...targetBranches].some(
      (ref) => !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes(".."),
    )
  ) {
    throw new Error("Supply distinct, valid source and target branch names.");
  }

  return { repository: input.repository, dryRun: input.dryRun, sourceRef, targetBranches };
}

// BOUNDARY: GitHub JSON is validated before it influences branch updates.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a GitHub JSON object. Inspect the GitHub response before retrying.");
  }

  // SAFETY: The check above excludes null, arrays and primitives; fields remain unknown.
  return value as Record<string, unknown>;
}

// BOUNDARY: Selected GitHub fields must be nonempty strings.
function text(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw new Error(
      "Expected a nonempty GitHub string. Inspect the GitHub response before retrying.",
    );
  }

  return value;
}

export function parsePullRequests(raw: string) {
  const rows: unknown = JSON.parse(raw);

  if (!Array.isArray(rows) || rows.length >= 500) {
    throw new Error(
      "Expected a complete list of fewer than 500 open pull requests. Narrow or clean up the open PRs before retrying.",
    );
  }

  const records: unknown[] = rows;

  return records.map((row) => {
    const item = object(row);

    return { url: text(item.url), headRefName: text(item.headRefName) };
  });
}

export function selectPullRequest(rows: ReturnType<typeof parsePullRequests>, branch: string) {
  const suffix = branch.replaceAll(/[^a-zA-Z0-9-]/g, "-");
  const pattern = new RegExp(`^chore/www-agent-assets-[0-9a-f]{8}-${suffix}$`);
  const matches = rows.filter((row) => pattern.test(row.headRefName));

  if (matches.length > 1) {
    throw new Error(
      `Found multiple open www asset sync PRs for base ${branch}. Resolve the duplicate PRs before retrying.`,
    );
  }

  return matches[0] ?? null;
}

export function parseCommit(raw: string) {
  const commit = object(JSON.parse(raw));

  const tree = text(object(commit.tree).sha);

  if (!/^[0-9a-f]{40}$/.test(tree)) {
    throw new Error(
      "GitHub returned an invalid tree SHA. Inspect the generated branch before retrying.",
    );
  }

  return { message: text(commit.message), tree };
}
