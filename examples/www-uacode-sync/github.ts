import { type CommandResult, command, sh } from "loopy";
import { readOptions } from "../options.ts";
import { object, parse, string } from "./json-edit.ts";
import { parseCommit, parsePullRequests, selectPullRequest } from "./publication.ts";
import type { Files } from "./sync.ts";

export function remoteSha(repo: string, ref: string) {
  return command(
    "github.remote-sha",
    {
      program: "gh",
      args: [
        "api",
        `repos/unify-apps/${repo}/git/ref/heads/${encodeURIComponent(ref)}`,
        "--jq",
        ".object.sha",
      ],
    },
    { ...readOptions, okExitCodes: [0, 1] },
    parseRemoteSha,
  );
}

function parseRemoteSha(result: CommandResult) {
  if (result.exitCode !== 0) {
    if (/\(HTTP 404\)/.test(result.stderr)) {
      return null;
    }

    throw new Error("GitHub ref lookup failed. Inspect stderr and retry the read.");
  }

  const sha = result.stdout.trim();

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      "GitHub returned an invalid commit SHA. Verify the requested repository and ref.",
    );
  }

  return sha;
}

export async function readSnapshot(repo: string, sha: string, paths: string[]) {
  const files: Files = {};

  for (const path of paths) {
    const result = await sh.exec(
      [
        "gh",
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/unify-apps/${repo}/contents/${path}?ref=${sha}`,
      ],
      readOptions,
    );

    files[path] = result.stdout;
  }

  return files;
}

export async function findPullRequest(branch: string) {
  const listed = await sh.exec(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      "unify-apps/uacode",
      "--base",
      branch,
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "url,headRefName",
    ],
    readOptions,
  );

  return selectPullRequest(parsePullRequests(listed.stdout), branch);
}

export async function readCommit(sha: string) {
  const result = await sh.exec(
    ["gh", "api", `repos/unify-apps/uacode/git/commits/${sha}`],
    readOptions,
  );

  return parseCommit(result.stdout);
}

export async function readTree(base: string, observed: string) {
  const result = await sh.exec(
    ["gh", "api", `repos/unify-apps/uacode/compare/${base}...${observed}`],
    readOptions,
  );

  const comparison = object(parse(result.stdout), "GitHub comparison");

  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) {
    throw new Error(
      "Cannot verify a missing or truncated comparison. Review the generated branch manually.",
    );
  }

  return comparison.files.map((value) => {
    const file = object(value, "comparison file");

    return {
      path: string(file.filename, "comparison filename"),
      sha: string(file.sha, "comparison blob SHA"),
      status: string(file.status, "comparison status"),
    };
  });
}
