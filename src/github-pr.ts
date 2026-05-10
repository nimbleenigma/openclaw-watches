import type { GitHubPrWatchSource } from "./types.js";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_REPO_REF_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9]\d*)$/;

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function createGitHubPrSource(params: {
  owner: string;
  repo: string;
  number: number;
}): GitHubPrWatchSource | undefined {
  if (!OWNER_PATTERN.test(params.owner) || !REPO_PATTERN.test(params.repo)) {
    return undefined;
  }
  return {
    owner: params.owner,
    repo: params.repo,
    number: params.number,
    url: `https://github.com/${params.owner}/${params.repo}/pull/${params.number}`,
    query: `${params.owner}/${params.repo}#${params.number}`,
  };
}

export function parseGitHubPrRef(input: string): GitHubPrWatchSource | undefined {
  const trimmed = input.trim();
  const shorthand = OWNER_REPO_REF_PATTERN.exec(trimmed);
  if (shorthand) {
    const number = parsePositiveInteger(shorthand[3] ?? "");
    if (!number) {
      return undefined;
    }
    return createGitHubPrSource({
      owner: shorthand[1] ?? "",
      repo: shorthand[2] ?? "",
      number,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "pull") {
    return undefined;
  }
  const number = parsePositiveInteger(segments[3] ?? "");
  if (!number) {
    return undefined;
  }
  return createGitHubPrSource({
    owner: segments[0] ?? "",
    repo: segments[1] ?? "",
    number,
  });
}

export function requireGitHubPrRef(input: string): GitHubPrWatchSource {
  const parsed = parseGitHubPrRef(input);
  if (!parsed) {
    throw new Error(
      "GitHub PR must be a https://github.com/<owner>/<repo>/pull/<number> URL or owner/repo#number.",
    );
  }
  return parsed;
}

export function formatGitHubPrRef(source: GitHubPrWatchSource): string {
  return `${source.owner}/${source.repo}#${source.number}`;
}
