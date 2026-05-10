import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WATCHES_CONFIG } from "./config.js";
import { createWatchManagementService, WatchManagementError } from "./management.js";
import type {
  CreateWatchInput,
  WatchDeliveryTarget,
  WatchEventRecord,
  WatchRecord,
} from "./types.js";

function createMemoryStore() {
  const watches = new Map<string, WatchRecord>();
  const events = new Map<string, WatchEventRecord[]>();
  return {
    watches,
    events,
    createWatch(input: CreateWatchInput): WatchRecord {
      const watch: WatchRecord = {
        id: input.id,
        ownerKey: input.ownerKey,
        ownerSessionKey: input.deliveryTarget.sessionKey,
        ownerSessionId: input.deliveryTarget.sessionId,
        ownerChannel: input.deliveryTarget.channel,
        ownerTo: input.deliveryTarget.to,
        ownerAccountId: input.deliveryTarget.accountId,
        ownerThreadId: input.deliveryTarget.threadId,
        ownerSenderId: input.deliveryTarget.senderId,
        title: input.title,
        kind: input.kind,
        source: input.source,
        condition: input.condition,
        status: "active",
        intervalSeconds: input.intervalSeconds,
        nextCheckAt: input.nextCheckAt,
        expiresAt: input.expiresAt,
        errorCount: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      watches.set(watch.id, watch);
      events.set(watch.id, [
        {
          id: `e_${watch.id}`,
          watchId: watch.id,
          eventType: "created",
          summary: watch.title,
          createdAt: input.createdAt,
        },
      ]);
      return watch;
    },
    countActiveForOwner(ownerKey: string): number {
      return [...watches.values()].filter(
        (watch) => watch.ownerKey === ownerKey && watch.status === "active",
      ).length;
    },
    listWatches(params?: { ownerKey?: string; includeAll?: boolean; limit?: number }) {
      return [...watches.values()]
        .filter((watch) => !params?.ownerKey || watch.ownerKey === params.ownerKey)
        .filter((watch) => params?.includeAll || watch.status === "active")
        .slice(0, params?.limit ?? 50);
    },
    getWatch(id: string): WatchRecord | undefined {
      return watches.get(id);
    },
    listEvents(watchId: string): WatchEventRecord[] {
      return events.get(watchId) ?? [];
    },
    cancelWatch(params: {
      id: string;
      ownerKey?: string;
      now: number;
      allowAnyOwner?: boolean;
    }): WatchRecord | undefined {
      const watch = watches.get(params.id);
      if (!watch) {
        return undefined;
      }
      if (!params.allowAnyOwner && params.ownerKey && watch.ownerKey !== params.ownerKey) {
        return undefined;
      }
      if (watch.status === "active") {
        watch.status = "cancelled";
        watch.cancelledAt = params.now;
        watch.updatedAt = params.now;
        events.set(watch.id, [
          ...(events.get(watch.id) ?? []),
          {
            id: `e_cancel_${watch.id}`,
            watchId: watch.id,
            eventType: "cancelled",
            summary: "Watch cancelled.",
            createdAt: params.now,
          },
        ]);
      }
      return watch;
    },
  };
}

function createContext(ownerKey = "telegram:alice", deliveryTarget?: WatchDeliveryTarget) {
  return {
    ownerKey,
    deliveryTarget: deliveryTarget ?? {
      sessionKey: "agent:main",
      sessionId: "main",
      channel: "telegram",
      to: "chat-1",
      accountId: "acct",
      threadId: "topic-1",
      senderId: "alice",
    },
  };
}

describe("WatchManagementService", () => {
  it("creates each supported watch kind through the programmatic service", () => {
    const store = createMemoryStore();
    const wakeScheduler = vi.fn();
    let nextId = 0;
    const manager = createWatchManagementService({
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
      idGenerator: () => `w_${++nextId}`,
      wakeScheduler,
    });
    const context = createContext();

    const model = manager.createModelAvailabilityWatch(context, { model: "openai/gpt-5.5" });
    const contains = manager.createUrlContainsWatch(context, {
      url: "https://example.com",
      text: "hello",
    });
    const matches = manager.createUrlRegexWatch(context, {
      url: "https://example.com/releases",
      regex: "GPT-5\\.5",
    });
    const changed = manager.createUrlChangedWatch(context, {
      url: "https://example.com/news",
    });
    const prChecks = manager.createGitHubPrChecksWatch(context, {
      pr: "https://github.com/openclaw/openclaw/pull/123",
    });
    const prChanged = manager.createGitHubPrStateWatch(context, {
      pr: "openclaw/openclaw#124",
    });

    expect(model).toMatchObject({
      id: "w_1",
      ownerKey: "telegram:alice",
      ownerChannel: "telegram",
      ownerTo: "chat-1",
      kind: "model",
      source: { provider: "openai", model: "gpt-5.5" },
      condition: { type: "available" },
      nextCheckAt: 1_000,
    });
    expect(contains).toMatchObject({
      id: "w_2",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "contains", text: "hello", caseSensitive: false },
    });
    expect(matches.condition).toEqual({ type: "matches", pattern: "GPT-5\\.5", flags: "i" });
    expect(changed.condition).toEqual({ type: "changed" });
    expect(prChecks).toMatchObject({
      id: "w_5",
      kind: "github_pr",
      source: {
        owner: "openclaw",
        repo: "openclaw",
        number: 123,
        url: "https://github.com/openclaw/openclaw/pull/123",
      },
      condition: { type: "github_pr_checks_pass" },
    });
    expect(prChanged).toMatchObject({
      id: "w_6",
      kind: "github_pr",
      source: { owner: "openclaw", repo: "openclaw", number: 124 },
      condition: { type: "github_pr_state_changed" },
    });
    expect(wakeScheduler).toHaveBeenCalledTimes(6);
  });

  it("applies and validates per-watch interval and expiry overrides", () => {
    const store = createMemoryStore();
    const manager = createWatchManagementService({
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
      idGenerator: () => "w_scheduled",
    });

    const watch = manager.createModelAvailabilityWatch(createContext(), {
      model: "openai/gpt-5.5",
      schedule: { intervalSeconds: 300, expiryMs: 7_200_000 },
    });
    expect(watch.intervalSeconds).toBe(300);
    expect(watch.expiresAt).toBe(7_201_000);

    expect(() =>
      manager.createUrlChangedWatch(createContext("telegram:bob"), {
        url: "https://example.com",
        schedule: { intervalSeconds: 30 },
      }),
    ).toThrow("interval");
    expect(() =>
      manager.createUrlChangedWatch(createContext("telegram:bob"), {
        url: "https://example.com",
        schedule: { expiryMs: 30_000 },
      }),
    ).toThrow("expiry");
  });

  it("lists, shows, and cancels watches scoped to the owner", () => {
    const store = createMemoryStore();
    const wakeScheduler = vi.fn();
    const manager = createWatchManagementService({
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
      idGenerator: () => "w_scoped",
      wakeScheduler,
    });
    const alice = createContext("telegram:alice");
    const bob = createContext("telegram:bob", { ...alice.deliveryTarget, senderId: "bob" });
    const created = manager.createModelAvailabilityWatch(alice, { model: "gpt-5.5" });

    expect(manager.listWatches(alice).map((watch) => watch.id)).toEqual(["w_scoped"]);
    expect(manager.listWatches(bob)).toEqual([]);
    expect(manager.showWatch(bob, created.id)).toBeUndefined();
    expect(manager.showWatchEvents(alice, created.id)).toMatchObject([{ eventType: "created" }]);
    expect(manager.showWatchEvents(bob, created.id)).toEqual([]);
    expect(manager.cancelWatch(bob, created.id)).toBeUndefined();
    expect(created.status).toBe("active");

    const cancelled = manager.cancelWatch(alice, created.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledAt).toBe(1_000);
    expect(manager.listWatches(alice)).toEqual([]);
    expect(manager.listWatches(alice, { includeAll: true }).map((watch) => watch.status)).toEqual([
      "cancelled",
    ]);
    expect(wakeScheduler).toHaveBeenCalledTimes(2);
  });

  it("creates URL page-text watches through the programmatic service", () => {
    const store = createMemoryStore();
    const manager = createWatchManagementService({
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
      idGenerator: () => "w_text",
    });
    const watch = manager.createUrlChangedWatch(createContext(), {
      url: "https://example.com",
      contentMode: "text",
    });

    expect(watch).toMatchObject({
      title: "URL text changed: https://example.com/",
      source: { url: "https://example.com/", contentMode: "text" },
      condition: { type: "changed" },
    });
    expect(() =>
      manager.createUrlContainsWatch(createContext("telegram:bob"), {
        url: "https://example.com",
        text: "hello",
        contentMode: "rendered" as never,
      }),
    ).toThrow("URL content mode must be raw or text");
  });

  it("validates limits and deterministic URL regex inputs before creating", () => {
    const store = createMemoryStore();
    const manager = createWatchManagementService({
      getStore: () => store,
      config: { ...DEFAULT_WATCHES_CONFIG, maxActivePerOwner: 1 },
      now: () => 1_000,
      idGenerator: () => `w_${store.watches.size + 1}`,
    });
    const context = createContext();

    manager.createUrlContainsWatch(context, { url: "https://example.com", text: "hello" });
    expect(() => manager.createModelAvailabilityWatch(context, { model: "gpt-5.5" })).toThrow(
      WatchManagementError,
    );
    expect(() =>
      manager.createUrlRegexWatch(createContext("telegram:bob"), {
        url: "https://example.com",
        regex: "[unterminated",
      }),
    ).toThrow("Regex pattern is invalid");
    expect(() =>
      manager.createUrlContainsWatch(createContext("telegram:bob"), {
        url: "file:///etc/passwd",
        text: "x",
      }),
    ).toThrow("http or https");
    expect(() =>
      manager.createGitHubPrChecksWatch(createContext("telegram:bob"), {
        pr: "https://example.com/openclaw/openclaw/pull/1",
      }),
    ).toThrow("GitHub PR must be");
  });
});
