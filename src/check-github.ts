import { hashWatchResult, truncateSummary } from "./evaluate.js";
import { formatGitHubPrRef } from "./github-pr.js";
import type { CheckOutcome, GitHubPrWatchSource, WatchRecord } from "./types.js";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "OpenClaw Watches/1",
  "x-github-api-version": GITHUB_API_VERSION,
} as const;

type FetchImpl = typeof fetch;

type GitHubPrApiResponse = {
  title: string;
  htmlUrl: string;
  state: string;
  draft: boolean;
  mergedAt?: string;
  mergeableState?: string;
  headSha: string;
};

type GitHubCombinedStatus = {
  state: string;
  statuses: Array<{ context: string; state: string }>;
};

type GitHubCheckRun = {
  name: string;
  status: string;
  conclusion?: string;
};

type GitHubChecksResponse = {
  totalCount: number;
  checkRuns: GitHubCheckRun[];
};

type GitHubChecksRollup = {
  state: "passing" | "pending" | "failing";
  summary: string;
  statusCount: number;
  checkRunCount: number;
  failingCount: number;
  pendingCount: number;
  passingCount: number;
};

type GitHubReview = {
  state: string;
  user: string;
  submittedAt?: string;
};

type GitHubReviewRollup = {
  approvedCount: number;
  changesRequestedCount: number;
  latestState?: string;
  latestUser?: string;
  summary: string;
};

export type GitHubPrSnapshot = {
  source: GitHubPrWatchSource;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergedAt?: string;
  mergeableState?: string;
  headSha: string;
  checks: GitHubChecksRollup;
  reviews: GitHubReviewRollup;
  summary: string;
  resultHash: string;
};

type SnapshotDisplay = {
  ref: string;
  title: string;
  state: string;
  checks: string;
  reviews: string;
  head: string;
};

class GitHubWatchFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubWatchFetchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function githubApiUrl(source: GitHubPrWatchSource, path: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(
    source.repo,
  )}${path}`;
}

function formatResetTime(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function formatGitHubHttpError(response: Response, url: string): string {
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const resetAt = formatResetTime(response.headers.get("x-ratelimit-reset"));
    return resetAt
      ? `GitHub API rate limit exceeded; resets at ${resetAt}`
      : "GitHub API rate limit exceeded";
  }
  return `GitHub API HTTP ${response.status} fetching ${url}`;
}

function githubHeaders(token?: string): Record<string, string> {
  const trimmedToken = token?.trim();
  return trimmedToken
    ? { ...GITHUB_HEADERS, authorization: `Bearer ${trimmedToken}` }
    : GITHUB_HEADERS;
}

async function fetchGitHubJson(params: {
  url: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  token?: string;
}): Promise<unknown> {
  const fetchFn = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetchFn(params.url, {
      headers: githubHeaders(params.token),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`GitHub API timed out after ${params.timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GitHubWatchFetchError(formatGitHubHttpError(response, params.url), response.status);
  }
  return await response.json();
}

function parsePullResponse(value: unknown, source: GitHubPrWatchSource): GitHubPrApiResponse {
  if (!isRecord(value)) {
    throw new Error("GitHub PR response was not an object");
  }
  const head = value.head;
  if (!isRecord(head)) {
    throw new Error("GitHub PR response did not include head details");
  }
  const headSha = readString(head, "sha");
  if (!headSha) {
    throw new Error("GitHub PR response did not include a head SHA");
  }
  return {
    title: readString(value, "title") ?? formatGitHubPrRef(source),
    htmlUrl: readString(value, "html_url") ?? source.url,
    state: readString(value, "state") ?? "unknown",
    draft: readBoolean(value, "draft") ?? false,
    mergedAt: readString(value, "merged_at"),
    mergeableState: readString(value, "mergeable_state"),
    headSha,
  };
}

function parseCombinedStatus(value: unknown): GitHubCombinedStatus {
  if (!isRecord(value)) {
    throw new Error("GitHub combined status response was not an object");
  }
  const statuses = readArray(value, "statuses")
    .filter(isRecord)
    .map((status) => ({
      context: readString(status, "context") ?? "status",
      state: readString(status, "state") ?? "unknown",
    }));
  return {
    state: readString(value, "state") ?? "unknown",
    statuses,
  };
}

function parseCheckRuns(value: unknown): GitHubChecksResponse {
  if (!isRecord(value)) {
    throw new Error("GitHub check-runs response was not an object");
  }
  const checkRuns = readArray(value, "check_runs")
    .filter(isRecord)
    .map((run) => ({
      name: readString(run, "name") ?? "check",
      status: readString(run, "status") ?? "unknown",
      conclusion: readString(run, "conclusion"),
    }));
  const totalCountValue = value.total_count;
  const totalCount = typeof totalCountValue === "number" ? totalCountValue : checkRuns.length;
  return { totalCount, checkRuns };
}

function parseReviews(value: unknown): GitHubReview[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub reviews response was not an array");
  }
  return value.filter(isRecord).map((review) => {
    const user = review.user;
    return {
      state: (readString(review, "state") ?? "unknown").toUpperCase(),
      user: isRecord(user) ? (readString(user, "login") ?? "unknown") : "unknown",
      submittedAt: readString(review, "submitted_at"),
    };
  });
}

function isPassingConclusion(value: string | undefined): boolean {
  return value === "success" || value === "neutral" || value === "skipped";
}

function isFailingConclusion(value: string | undefined): boolean {
  return (
    value === "failure" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "action_required" ||
    value === "stale" ||
    value === "startup_failure"
  );
}

function rollupChecks(
  combinedStatus: GitHubCombinedStatus,
  checkRuns: GitHubChecksResponse,
): GitHubChecksRollup {
  let failingCount = 0;
  let pendingCount = 0;
  let passingCount = 0;

  if (combinedStatus.state === "failure" || combinedStatus.state === "error") {
    failingCount += 1;
  } else if (combinedStatus.state === "pending" && combinedStatus.statuses.length > 0) {
    pendingCount += 1;
  } else if (combinedStatus.state === "success" && combinedStatus.statuses.length > 0) {
    passingCount += combinedStatus.statuses.length;
  }

  for (const run of checkRuns.checkRuns) {
    if (run.status !== "completed") {
      pendingCount += 1;
      continue;
    }
    if (isPassingConclusion(run.conclusion)) {
      passingCount += 1;
      continue;
    }
    if (isFailingConclusion(run.conclusion)) {
      failingCount += 1;
      continue;
    }
    pendingCount += 1;
  }

  const signalCount = combinedStatus.statuses.length + checkRuns.checkRuns.length;
  if (failingCount > 0) {
    return {
      state: "failing",
      summary: `failing (${failingCount} failing, ${pendingCount} pending)`,
      statusCount: combinedStatus.statuses.length,
      checkRunCount: checkRuns.totalCount,
      failingCount,
      pendingCount,
      passingCount,
    };
  }
  if (pendingCount > 0 || signalCount === 0) {
    return {
      state: "pending",
      summary:
        signalCount === 0
          ? "pending (no checks reported)"
          : `pending (${pendingCount} pending, ${passingCount} passing)`,
      statusCount: combinedStatus.statuses.length,
      checkRunCount: checkRuns.totalCount,
      failingCount,
      pendingCount: signalCount === 0 ? 1 : pendingCount,
      passingCount,
    };
  }
  return {
    state: "passing",
    summary: `passing (${passingCount} passing)`,
    statusCount: combinedStatus.statuses.length,
    checkRunCount: checkRuns.totalCount,
    failingCount,
    pendingCount,
    passingCount,
  };
}

function prStateLabel(pr: GitHubPrApiResponse): string {
  if (pr.mergedAt) {
    return "merged";
  }
  return pr.draft ? `${pr.state} draft` : pr.state;
}

function checksLabel(checks: GitHubChecksRollup): string {
  if (checks.state === "passing") {
    return `${checks.passingCount} passing`;
  }
  if (checks.state === "failing") {
    const parts = [`${checks.failingCount} failing`];
    if (checks.pendingCount > 0) {
      parts.push(`${checks.pendingCount} pending`);
    }
    return parts.join(", ");
  }
  if (checks.statusCount + checks.checkRunCount === 0) {
    return "pending (no checks reported)";
  }
  const parts = [`${checks.pendingCount} pending`];
  if (checks.passingCount > 0) {
    parts.push(`${checks.passingCount} passing`);
  }
  return parts.join(", ");
}

function rollupReviews(reviews: GitHubReview[]): GitHubReviewRollup {
  const latestByUser = new Map<string, GitHubReview>();
  for (const review of reviews) {
    const previous = latestByUser.get(review.user);
    if (!previous || (review.submittedAt ?? "") >= (previous.submittedAt ?? "")) {
      latestByUser.set(review.user, review);
    }
  }
  const latest = [...reviews].toSorted((a, b) =>
    (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""),
  )[0];
  let approvedCount = 0;
  let changesRequestedCount = 0;
  for (const review of latestByUser.values()) {
    if (review.state === "APPROVED") {
      approvedCount += 1;
    }
    if (review.state === "CHANGES_REQUESTED") {
      changesRequestedCount += 1;
    }
  }
  const parts: string[] = [];
  if (approvedCount > 0) {
    parts.push(`${approvedCount} approved`);
  }
  if (changesRequestedCount > 0) {
    parts.push(`${changesRequestedCount} changes requested`);
  }
  return {
    approvedCount,
    changesRequestedCount,
    latestState: latest?.state,
    latestUser: latest?.user,
    summary: parts.length > 0 ? parts.join(", ") : "no active review signal",
  };
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function snapshotHash(params: {
  pr: GitHubPrApiResponse;
  checks: GitHubChecksRollup;
  reviews: GitHubReviewRollup;
}): string {
  return hashWatchResult(
    JSON.stringify({
      state: params.pr.state,
      draft: params.pr.draft,
      mergedAt: params.pr.mergedAt ?? null,
      mergeableState: params.pr.mergeableState ?? null,
      headSha: params.pr.headSha,
      checksState: params.checks.state,
      failingCount: params.checks.failingCount,
      pendingCount: params.checks.pendingCount,
      passingCount: params.checks.passingCount,
      statusCount: params.checks.statusCount,
      checkRunCount: params.checks.checkRunCount,
      reviewApprovedCount: params.reviews.approvedCount,
      reviewChangesRequestedCount: params.reviews.changesRequestedCount,
      latestReviewState: params.reviews.latestState ?? null,
      latestReviewUser: params.reviews.latestUser ?? null,
    }),
  );
}

function formatSnapshotSummary(params: {
  source: GitHubPrWatchSource;
  pr: GitHubPrApiResponse;
  checks: GitHubChecksRollup;
  reviews: GitHubReviewRollup;
}): string {
  return truncateSummary(
    `PR snapshot: ${formatGitHubPrRef(params.source)} — ${params.pr.title} | State: ${prStateLabel(
      params.pr,
    )} | Checks: ${checksLabel(params.checks)} | Reviews: ${
      params.reviews.summary
    } | Head: ${shortSha(params.pr.headSha)}`,
  );
}

function snapshotDisplay(snapshot: GitHubPrSnapshot): SnapshotDisplay {
  return {
    ref: formatGitHubPrRef(snapshot.source),
    title: snapshot.title,
    state: snapshot.merged ? "merged" : snapshot.draft ? `${snapshot.state} draft` : snapshot.state,
    checks: checksLabel(snapshot.checks),
    reviews: snapshot.reviews.summary,
    head: shortSha(snapshot.headSha),
  };
}

function parsePreviousSnapshotDisplay(summary?: string): Partial<SnapshotDisplay> | undefined {
  if (!summary) {
    return undefined;
  }
  const state = /\bState:\s*([^|]+)/.exec(summary)?.[1]?.trim();
  const checks = /\bChecks:\s*([^|]+)/.exec(summary)?.[1]?.trim();
  const reviews = /\bReviews:\s*([^|]+)/.exec(summary)?.[1]?.trim();
  const head = /\bHead:\s*([^|]+)/.exec(summary)?.[1]?.trim();
  if (!state && !checks && !reviews && !head) {
    return undefined;
  }
  return { state, checks, reviews, head };
}

function formatDelta(previous: string | undefined, current: string): string {
  return previous && previous !== current ? `${previous} → ${current}` : current;
}

export function formatGitHubPrNotification(params: {
  kind:
    | "checks_passed"
    | "checks_failed"
    | "merged"
    | "approved"
    | "changes_requested"
    | "snapshot_changed";
  snapshot: GitHubPrSnapshot;
  previousSummary?: string;
}): string {
  const current = snapshotDisplay(params.snapshot);
  const previous = parsePreviousSnapshotDisplay(params.previousSummary);
  const heading =
    params.kind === "checks_passed"
      ? "✅ PR checks passed"
      : params.kind === "checks_failed"
        ? "❌ PR checks failed"
        : params.kind === "merged"
          ? "✅ PR merged"
          : params.kind === "approved"
            ? "✅ PR approved"
            : params.kind === "changes_requested"
              ? "🛠️ PR changes requested"
              : "👀 PR snapshot changed";
  const lines = [
    heading,
    "",
    `${current.ref} — ${current.title}`,
    `State: ${formatDelta(previous?.state, current.state)}`,
    `Checks: ${formatDelta(previous?.checks, current.checks)}`,
    `Reviews: ${formatDelta(previous?.reviews, current.reviews)}`,
    `Head: ${formatDelta(previous?.head, current.head)}`,
    "",
    params.snapshot.url,
  ];
  return lines.join("\n");
}

export async function fetchGitHubPrSnapshot(params: {
  source: GitHubPrWatchSource;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  includeReviews?: boolean;
  token?: string;
}): Promise<GitHubPrSnapshot> {
  const pr = parsePullResponse(
    await fetchGitHubJson({
      url: githubApiUrl(params.source, `/pulls/${params.source.number}`),
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      token: params.token,
    }),
    params.source,
  );
  const combinedStatus = parseCombinedStatus(
    await fetchGitHubJson({
      url: githubApiUrl(params.source, `/commits/${pr.headSha}/status`),
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      token: params.token,
    }),
  );
  const checkRuns = parseCheckRuns(
    await fetchGitHubJson({
      url: githubApiUrl(params.source, `/commits/${pr.headSha}/check-runs?per_page=100`),
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
      token: params.token,
    }),
  );
  const reviews = params.includeReviews
    ? rollupReviews(
        parseReviews(
          await fetchGitHubJson({
            url: githubApiUrl(params.source, `/pulls/${params.source.number}/reviews?per_page=100`),
            timeoutMs: params.timeoutMs,
            fetchImpl: params.fetchImpl,
            token: params.token,
          }),
        ),
      )
    : rollupReviews([]);
  const checks = rollupChecks(combinedStatus, checkRuns);
  const summary = formatSnapshotSummary({ source: params.source, pr, checks, reviews });
  return {
    source: params.source,
    title: pr.title,
    url: pr.htmlUrl,
    state: pr.state,
    draft: pr.draft,
    merged: Boolean(pr.mergedAt),
    mergedAt: pr.mergedAt,
    mergeableState: pr.mergeableState,
    headSha: pr.headSha,
    checks,
    reviews,
    summary,
    resultHash: snapshotHash({ pr, checks, reviews }),
  };
}

export async function checkGitHubPrWatch(params: {
  watch: WatchRecord;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  token?: string;
}): Promise<CheckOutcome> {
  if (params.watch.kind !== "github_pr") {
    throw new Error(`Expected GitHub PR watch, got ${params.watch.kind}`);
  }
  const source = params.watch.source as GitHubPrWatchSource;
  const includeReviews =
    params.watch.condition.type === "github_pr_review_approved" ||
    params.watch.condition.type === "github_pr_review_changes_requested" ||
    params.watch.condition.type === "github_pr_state_changed";
  const snapshot = await fetchGitHubPrSnapshot({
    source,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    includeReviews,
    token: params.token,
  });

  if (params.watch.condition.type === "github_pr_checks_pass") {
    if (snapshot.checks.state !== "passing") {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: snapshot.summary,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: snapshot.summary,
      notification: formatGitHubPrNotification({
        kind: "checks_passed",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  if (params.watch.condition.type === "github_pr_checks_fail") {
    if (snapshot.checks.state !== "failing") {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: snapshot.summary,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: snapshot.summary,
      notification: formatGitHubPrNotification({
        kind: "checks_failed",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  if (params.watch.condition.type === "github_pr_merged") {
    if (!snapshot.merged) {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: snapshot.summary,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: snapshot.summary,
      notification: formatGitHubPrNotification({
        kind: "merged",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  if (params.watch.condition.type === "github_pr_review_approved") {
    if (snapshot.reviews.approvedCount === 0) {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: snapshot.summary,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: snapshot.summary,
      notification: formatGitHubPrNotification({
        kind: "approved",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  if (params.watch.condition.type === "github_pr_review_changes_requested") {
    if (snapshot.reviews.changesRequestedCount === 0) {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: snapshot.summary,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: snapshot.summary,
      notification: formatGitHubPrNotification({
        kind: "changes_requested",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  if (params.watch.condition.type === "github_pr_state_changed") {
    if (!params.watch.lastResultHash) {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: `Baseline captured: ${snapshot.summary}`,
        payload: snapshot,
      };
    }
    if (params.watch.lastResultHash === snapshot.resultHash) {
      return {
        triggered: false,
        resultHash: snapshot.resultHash,
        summary: `No PR snapshot change: ${snapshot.summary}`,
        payload: snapshot,
      };
    }
    return {
      triggered: true,
      resultHash: snapshot.resultHash,
      summary: `PR snapshot changed: ${snapshot.summary}`,
      notification: formatGitHubPrNotification({
        kind: "snapshot_changed",
        snapshot,
        previousSummary: params.watch.lastResultSummary,
      }),
      payload: snapshot,
    };
  }

  throw new Error(`Unsupported GitHub PR watch condition: ${params.watch.condition.type}`);
}
