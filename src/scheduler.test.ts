import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WATCHES_CONFIG } from "./config.js";
import { WatchesScheduler } from "./scheduler.js";
import { resolveWatchesSqlitePath, WatchesStore } from "./store.sqlite.js";
import type { CheckOutcome, CreateWatchInput, WatchRecord } from "./types.js";

async function withStore(run: (store: WatchesStore) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watches-scheduler-"));
  const store = new WatchesStore(resolveWatchesSqlitePath(dir));
  try {
    await run(store);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createInput(params: { id: string; now: number; expiresAt?: number }): CreateWatchInput {
  return {
    id: params.id,
    ownerKey: "telegram:alice",
    deliveryTarget: {
      sessionKey: "agent:main",
      channel: "telegram",
      to: "chat-1",
    },
    title: "URL contains: hello",
    kind: "url",
    source: { url: "https://example.com/" },
    condition: { type: "contains", text: "hello" },
    intervalSeconds: 60,
    nextCheckAt: params.now,
    expiresAt: params.expiresAt ?? params.now + 60_000,
    createdAt: params.now,
  };
}

function createRuntime() {
  return {
    system: {
      notifyCapturedTarget: vi.fn(async () => ({ delivered: true, via: "direct" as const })),
    },
  };
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

function createPassingGitHubFetch() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/pulls/123")) {
      return new Response(
        JSON.stringify({
          title: "Tighten the bolts",
          html_url: "https://github.com/openclaw/openclaw/pull/123",
          state: "open",
          draft: false,
          merged_at: null,
          mergeable_state: "clean",
          head: { sha: "abc1234567890" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/commits/abc1234567890/status")) {
      return new Response(
        JSON.stringify({
          state: "success",
          statuses: [{ context: "ci", state: "success" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/commits/abc1234567890/check-runs?per_page=100")) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected GitHub API URL: ${url}`);
  });
}

function requestAuthHeader(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  const headers = init?.headers;
  return headers && !Array.isArray(headers) && !(headers instanceof Headers)
    ? (headers as Record<string, string>).authorization
    : undefined;
}

describe("WatchesScheduler", () => {
  it("triggers due watches once and notifies the captured target", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput({ id: "w_a", now: 1_000 }));
      const runtime = createRuntime();
      const scheduler = new WatchesScheduler({
        store,
        runtime: runtime as never,
        cfg: {},
        config: DEFAULT_WATCHES_CONFIG,
        claimedBy: "test-worker",
        now: () => 1_000,
        evaluator: async (): Promise<CheckOutcome> => ({
          triggered: true,
          resultHash: "hash-a",
          summary: "matched",
          notification: "Watch triggered",
        }),
      });

      await scheduler.tickOnce();

      expect(store.getWatch("w_a")?.status).toBe("triggered");
      expect(runtime.system.notifyCapturedTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Watch triggered",
          target: expect.objectContaining({ channel: "telegram", to: "chat-1" }),
          idempotencyKey: "watch:w_a:trigger:hash-a",
        }),
      );
    });
  });

  it("does not trigger or stamp notified hash when notification delivery is unconfirmed", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput({ id: "w_a", now: 1_000, expiresAt: 1_000_000 }));
      const runtime = {
        system: {
          notifyCapturedTarget: vi.fn(async () => ({
            delivered: false as const,
            via: "none" as const,
            error: "direct notification produced no delivered message",
          })),
        },
      };
      const scheduler = new WatchesScheduler({
        store,
        runtime: runtime as never,
        cfg: {},
        config: DEFAULT_WATCHES_CONFIG,
        claimedBy: "test-worker",
        now: () => 1_000,
        evaluator: async (): Promise<CheckOutcome> => ({
          triggered: true,
          resultHash: "hash-a",
          summary: "matched",
          notification: "Watch triggered",
        }),
      });

      await scheduler.tickOnce();

      const watch = store.getWatch("w_a");
      expect(watch?.status).toBe("active");
      expect(watch?.lastNotifiedHash).toBeUndefined();
      expect(watch?.lastResultHash).toBeUndefined();
      expect(watch?.errorCount).toBe(1);
      expect(watch?.lastError).toContain("direct notification produced no delivered message");
      expect(watch?.nextCheckAt).toBeGreaterThan(1_000);
      expect(runtime.system.notifyCapturedTarget).toHaveBeenCalledOnce();
    });
  });

  it("keeps non-triggered watches active and schedules the next interval", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput({ id: "w_a", now: 1_000 }));
      const scheduler = new WatchesScheduler({
        store,
        runtime: createRuntime() as never,
        cfg: {},
        config: DEFAULT_WATCHES_CONFIG,
        claimedBy: "test-worker",
        now: () => 2_000,
        evaluator: async () => ({
          triggered: false,
          resultHash: "hash-a",
          summary: "no change",
        }),
      });

      await scheduler.tickOnce();

      const watch = store.getWatch("w_a");
      expect(watch?.status).toBe("active");
      expect(watch?.nextCheckAt).toBe(62_000);
      expect(watch?.claimedBy).toBeUndefined();
    });
  });

  it("dispatches GitHub PR checks through the default evaluator", async () => {
    await withStore(async (store) => {
      store.createWatch({
        ...createInput({ id: "w_pr", now: 1_000 }),
        title: "PR checks: openclaw/openclaw#123",
        kind: "github_pr",
        source: {
          owner: "openclaw",
          repo: "openclaw",
          number: 123,
          url: "https://github.com/openclaw/openclaw/pull/123",
          query: "openclaw/openclaw#123",
        },
        condition: { type: "github_pr_checks_pass" },
      });
      const runtime = createRuntime();
      const fetchImpl = createPassingGitHubFetch();
      const originalFetch = globalThis.fetch;
      const tokenEnv = "OPENCLAW_WATCHES_TEST_GITHUB_TOKEN";
      const originalToken = process.env[tokenEnv];
      process.env[tokenEnv] = "test-token-123";
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const scheduler = new WatchesScheduler({
          store,
          runtime: runtime as never,
          cfg: {},
          config: { ...DEFAULT_WATCHES_CONFIG, githubTokenEnv: tokenEnv },
          claimedBy: "test-worker",
          now: () => 1_000,
        });

        await scheduler.tickOnce();

        expect(store.getWatch("w_pr")?.status).toBe("triggered");
        expect(runtime.system.notifyCapturedTarget).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("openclaw/openclaw#123"),
            idempotencyKey: expect.stringMatching(/^watch:w_pr:trigger:/),
          }),
        );
        expect(fetchImpl.mock.calls.map(requestAuthHeader)).toEqual([
          "Bearer test-token-123",
          "Bearer test-token-123",
          "Bearer test-token-123",
        ]);
      } finally {
        vi.stubGlobal("fetch", originalFetch);
        if (originalToken === undefined) {
          delete process.env[tokenEnv];
        } else {
          process.env[tokenEnv] = originalToken;
        }
      }
    });
  });

  it("expires watches before evaluating them", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput({ id: "w_a", now: 1_000, expiresAt: 1_500 }));
      const evaluator = vi.fn();
      const scheduler = new WatchesScheduler({
        store,
        runtime: createRuntime() as never,
        cfg: {},
        config: DEFAULT_WATCHES_CONFIG,
        claimedBy: "test-worker",
        now: () => 2_000,
        evaluator,
      });

      await scheduler.tickOnce();

      expect(store.getWatch("w_a")?.status).toBe("expired");
      expect(evaluator).not.toHaveBeenCalled();
    });
  });

  it("backs off transient failures and marks terminal failures", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput({ id: "w_a", now: 1_000, expiresAt: 1_000_000 }));
      const runtime = createRuntime();
      const transientScheduler = new WatchesScheduler({
        store,
        runtime: runtime as never,
        cfg: {},
        config: { ...DEFAULT_WATCHES_CONFIG, maxConsecutiveErrors: 2 },
        claimedBy: "test-worker",
        now: () => 1_000,
        evaluator: async (_watch: WatchRecord) => {
          throw new Error("network down");
        },
      });

      await transientScheduler.tickOnce();

      const transient = store.getWatch("w_a");
      expect(transient?.status).toBe("active");
      expect(transient?.errorCount).toBe(1);
      expect(transient?.lastError).toBe("network down");
      expect(transient?.nextCheckAt).toBeGreaterThan(1_000);
      expect(runtime.system.notifyCapturedTarget).not.toHaveBeenCalled();

      const scheduler = new WatchesScheduler({
        store,
        runtime: runtime as never,
        cfg: {},
        config: { ...DEFAULT_WATCHES_CONFIG, maxConsecutiveErrors: 2 },
        claimedBy: "test-worker",
        now: () => transient?.nextCheckAt ?? 123_000,
        evaluator: async (_watch: WatchRecord) => {
          throw new Error("network down");
        },
      });

      await scheduler.tickOnce();

      const watch = store.getWatch("w_a");
      expect(watch?.status).toBe("failed");
      expect(watch?.nextCheckAt).toBeUndefined();
      expect(runtime.system.notifyCapturedTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("network down"),
          idempotencyKey: "watch:w_a:failed",
        }),
      );
    });
  });
});
