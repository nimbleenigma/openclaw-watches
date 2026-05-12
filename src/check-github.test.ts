import { describe, expect, it, vi } from "vitest";
import { checkGitHubPrWatch, fetchGitHubPrSnapshot } from "./check-github.js";
import type { GitHubPrWatchSource, WatchRecord } from "./types.js";

const source: GitHubPrWatchSource = {
  owner: "openclaw",
  repo: "openclaw",
  number: 123,
  url: "https://github.com/openclaw/openclaw/pull/123",
  query: "openclaw/openclaw#123",
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/json");
  return new Response(JSON.stringify(body), {
    headers,
    status: init?.status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function createGitHubFetch(
  params: {
    sha?: string;
    state?: string;
    draft?: boolean;
    mergedAt?: string | null;
    statusState?: string;
    statuses?: Array<{ context: string; state: string }>;
    checkRuns?: Array<{ name: string; status: string; conclusion?: string | null }>;
    reviews?: Array<{ state: string; user?: { login: string }; submitted_at?: string }>;
  } = {},
) {
  const sha = params.sha ?? "abc1234567890";
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/pulls/123")) {
      return jsonResponse({
        title: "Tighten the bolts",
        html_url: source.url,
        state: params.state ?? "open",
        draft: params.draft ?? false,
        merged_at: params.mergedAt ?? null,
        mergeable_state: "clean",
        head: { sha },
      });
    }
    if (url.endsWith(`/commits/${sha}/status`)) {
      return jsonResponse({
        state: params.statusState ?? "success",
        statuses: params.statuses ?? [{ context: "ci", state: "success" }],
      });
    }
    if (url.endsWith(`/commits/${sha}/check-runs?per_page=100`)) {
      const checkRuns = params.checkRuns ?? [
        { name: "test", status: "completed", conclusion: "success" },
      ];
      return jsonResponse({
        total_count: checkRuns.length,
        check_runs: checkRuns,
      });
    }
    if (url.endsWith("/pulls/123/reviews?per_page=100")) {
      return jsonResponse(params.reviews ?? []);
    }
    throw new Error(`Unexpected GitHub API URL: ${url}`);
  });
}

function authHeader(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  const headers = init?.headers;
  return headers && !Array.isArray(headers) && !(headers instanceof Headers)
    ? headers.authorization
    : undefined;
}

function createGitHubWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "w_github",
    ownerKey: "test",
    title: "PR checks: openclaw/openclaw#123",
    kind: "github_pr",
    source,
    condition: { type: "github_pr_checks_pass" },
    status: "active",
    intervalSeconds: 60,
    nextCheckAt: 1,
    expiresAt: 10_000,
    errorCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("GitHub PR checks", () => {
  it("triggers checks-pass watches when statuses and check runs pass", async () => {
    const outcome = await checkGitHubPrWatch({
      watch: createGitHubWatch(),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        state: "closed",
        statuses: [],
        checkRuns: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "success" },
          { name: "typecheck", status: "completed", conclusion: "success" },
          { name: "build", status: "completed", conclusion: "success" },
        ],
      }),
    });

    expect(outcome.triggered).toBe(true);
    if (!outcome.triggered) {
      throw new Error("expected checks-pass watch to trigger");
    }
    expect(outcome.summary).toContain("Checks: 4 passing");
    expect(outcome.summary).toContain("openclaw/openclaw#123");
    expect(outcome.notification).toContain("✅ PR checks passed");
    expect(outcome.notification).toContain("openclaw/openclaw#123 — Tighten the bolts");
    expect(outcome.notification).toContain("State: closed");
    expect(outcome.notification).toContain("Checks: 4 passing");
    expect(outcome.notification).toContain("Reviews: no active review signal");
    expect(outcome.notification).toContain("Head: abc1234");
  });

  it("keeps checks-pass watches active while checks are pending or absent", async () => {
    const outcome = await checkGitHubPrWatch({
      watch: createGitHubWatch(),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        statusState: "pending",
        statuses: [],
        checkRuns: [],
      }),
    });

    expect(outcome.triggered).toBe(false);
    expect(outcome.summary).toContain("pending");
    expect(outcome.summary).toContain("no checks reported");
  });

  it("captures baseline before triggering on later PR snapshot changes", async () => {
    const baseline = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR snapshot: openclaw/openclaw#123",
        condition: { type: "github_pr_state_changed" },
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        sha: "abc1234567890",
        statusState: "pending",
        statuses: [],
        checkRuns: [],
      }),
    });
    expect(baseline.triggered).toBe(false);
    expect(baseline.summary).toContain("Baseline captured");

    const unchanged = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR snapshot: openclaw/openclaw#123",
        condition: { type: "github_pr_state_changed" },
        lastResultHash: baseline.resultHash,
        lastResultSummary: baseline.summary,
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        sha: "abc1234567890",
        statusState: "pending",
        statuses: [],
        checkRuns: [],
      }),
    });
    expect(unchanged.triggered).toBe(false);
    expect(unchanged.summary).toContain("No PR snapshot change");

    const changed = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR snapshot: openclaw/openclaw#123",
        condition: { type: "github_pr_state_changed" },
        lastResultHash: baseline.resultHash,
        lastResultSummary: baseline.summary,
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({ sha: "def9876543210" }),
    });
    expect(changed.triggered).toBe(true);
    if (!changed.triggered) {
      throw new Error("expected snapshot watch to trigger");
    }
    expect(changed.summary).toContain("PR snapshot changed");
    expect(changed.notification).toContain("👀 PR snapshot changed");
    expect(changed.notification).toContain("State: open");
    expect(changed.notification).toContain("Checks: pending (no checks reported) → 2 passing");
    expect(changed.notification).toContain("Reviews: no active review signal");
    expect(changed.notification).toContain("Head: abc1234 → def9876");
  });

  it("triggers richer PR conditions for failing checks, merge, and review state", async () => {
    const failed = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR checks failing: openclaw/openclaw#123",
        condition: { type: "github_pr_checks_fail" },
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        statusState: "failure",
        checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }],
      }),
    });
    expect(failed.triggered).toBe(true);
    if (!failed.triggered) {
      throw new Error("expected failed-check watch to trigger");
    }
    expect(failed.notification).toContain("❌ PR checks failed");

    const merged = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR merged: openclaw/openclaw#123",
        condition: { type: "github_pr_merged" },
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({ state: "closed", mergedAt: "2026-05-10T10:00:00Z" }),
    });
    expect(merged.triggered).toBe(true);

    const approved = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR approved: openclaw/openclaw#123",
        condition: { type: "github_pr_review_approved" },
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        reviews: [
          {
            state: "APPROVED",
            user: { login: "eva" },
            submitted_at: "2026-05-10T11:00:00Z",
          },
        ],
      }),
    });
    expect(approved.triggered).toBe(true);
    if (!approved.triggered) {
      throw new Error("expected approved watch to trigger");
    }
    expect(approved.notification).toContain("Reviews: 1 approved");

    const changesRequested = await checkGitHubPrWatch({
      watch: createGitHubWatch({
        title: "PR changes requested: openclaw/openclaw#123",
        condition: { type: "github_pr_review_changes_requested" },
      }),
      timeoutMs: 1000,
      fetchImpl: createGitHubFetch({
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            user: { login: "eva" },
            submitted_at: "2026-05-10T11:00:00Z",
          },
        ],
      }),
    });
    expect(changesRequested.triggered).toBe(true);
    if (!changesRequested.triggered) {
      throw new Error("expected changes-requested watch to trigger");
    }
    expect(changesRequested.notification).toContain("Reviews: 1 changes requested");
  });

  it("surfaces GitHub API rate limits as non-terminal scheduler errors", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { message: "rate limited" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000",
          },
        },
      ),
    );

    await expect(
      fetchGitHubPrSnapshot({
        source,
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).rejects.toThrow("GitHub API rate limit exceeded");
  });

  it("uses optional bearer tokens only in GitHub API request headers", async () => {
    const fetchImpl = createGitHubFetch();
    const token = "test-token-123";

    const snapshot = await fetchGitHubPrSnapshot({
      source,
      timeoutMs: 1000,
      fetchImpl,
      token,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(authHeader)).toEqual([
      `Bearer ${token}`,
      `Bearer ${token}`,
      `Bearer ${token}`,
    ]);
    expect(snapshot.summary).not.toContain(token);
    expect(snapshot.resultHash).not.toContain(token);
  });
});
