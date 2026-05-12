import { describe, expect, it, vi } from "vitest";
import { createWatchesCommands } from "./commands.js";
import { DEFAULT_WATCHES_CONFIG } from "./config.js";
import type { CreateWatchInput, WatchEventRecord, WatchRecord } from "./types.js";

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

function createContext(args: string, senderId = "alice") {
  return {
    senderId,
    channel: "telegram",
    isAuthorizedSender: true,
    sessionKey: "agent:main",
    sessionId: "main",
    args,
    commandBody: args ? `/watch ${args}` : "/watch",
    config: {},
    from: "chat-1",
    accountId: "acct",
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
  };
}

describe("watch commands", () => {
  it("creates watches and lists them for the owner", async () => {
    const store = createMemoryStore();
    const wakeScheduler = vi.fn();
    const [watchCommand, watchesCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
      wakeScheduler,
    });

    const created = await watchCommand.handler(
      createContext('url https://example.com contains "hello"') as never,
    );
    expect(created.text).toContain("created");
    expect(store.watches.size).toBe(1);
    expect(wakeScheduler).toHaveBeenCalled();

    const listed = await watchesCommand.handler(createContext("") as never);
    expect(listed.text).toContain("Active watches:");
    expect(listed.text).toContain("Active watches: 1");
    expect(listed.text).toContain("URL contains: hello");
    expect(listed.text).toContain("Next: now");
    expect(listed.text).toContain("Expires: in 1d");
    expect(listed.text).toContain("Last:");
  });

  it("creates watches with per-watch schedule suffixes", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });

    const created = await watchCommand.handler(
      createContext("models gpt-5.5 until available every 5m for 2h") as never,
    );
    const watch = [...store.watches.values()][0];
    expect(watch?.intervalSeconds).toBe(300);
    expect(watch?.expiresAt).toBe(7_201_000);
    expect(created.text).toContain("interval: 300s");
    expect(created.text).toContain("(now)");
    expect(created.text).toContain("(in 2h)");
  });

  it("shows watches owned by the caller", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });
    await watchCommand.handler(createContext("models gpt-5.5 until available", "alice") as never);
    const id = [...store.watches.keys()][0];
    const shown = await watchCommand.handler(createContext(`show ${id}`, "alice") as never);
    expect(shown.text).toContain(`Watch ${id}`);
    expect(shown.text).toContain("- status: active");
    expect(shown.text).toContain("Recent events:");
    expect(shown.text).toContain("created");

    const denied = await watchCommand.handler(createContext(`show ${id}`, "bob") as never);
    expect(denied.text).toContain("No watch found");
  });

  it("supports show and cancel aliases through /watches", async () => {
    const store = createMemoryStore();
    const [watchCommand, watchesCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });

    await watchCommand.handler(createContext("models gpt-5.5 until available", "alice") as never);
    const id = [...store.watches.keys()][0];

    const shown = await watchesCommand.handler(createContext(`show ${id}`, "alice") as never);
    expect(shown.text).toContain(`Watch ${id}`);
    expect(shown.text).toContain("Recent events:");

    const cancelled = await watchesCommand.handler(createContext(`cancel ${id}`, "alice") as never);
    expect(cancelled.text).toContain("cancelled");
    expect(store.watches.get(id)?.status).toBe("cancelled");

    const all = await watchesCommand.handler(createContext("all", "alice") as never);
    expect(all.text).toContain("cancelled");
  });

  it("lists compact last result and error details", async () => {
    const store = createMemoryStore();
    const [watchCommand, watchesCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });
    await watchCommand.handler(createContext('url https://example.com contains "hello"') as never);
    const id = [...store.watches.keys()][0];
    const watch = store.watches.get(id);
    if (!watch) {
      throw new Error("watch was not created");
    }
    watch.lastResultSummary = "Text not found: hello HTTP 200 https://example.com/";
    watch.lastError = "HTTP 403 fetching https://example.com/";

    const listed = await watchesCommand.handler(createContext("all") as never);
    expect(listed.text).toContain("Last: Text not found");
    expect(listed.text).toContain("Error: HTTP 403");
  });

  it("cancels only watches owned by the caller and reports final status", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });
    await watchCommand.handler(createContext("models gpt-5.5 until available", "alice") as never);
    const id = [...store.watches.keys()][0];

    const denied = await watchCommand.handler(createContext(`cancel ${id}`, "bob") as never);
    expect(denied.text).toContain("No watch found");
    expect(store.watches.get(id)?.status).toBe("active");

    const cancelled = await watchCommand.handler(createContext(`cancel ${id}`, "alice") as never);
    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.text).toContain("final status: cancelled");
    expect(store.watches.get(id)?.status).toBe("cancelled");
  });

  it("enforces the active watch limit per owner", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: { ...DEFAULT_WATCHES_CONFIG, maxActivePerOwner: 1 },
      now: () => 1_000,
    });

    await watchCommand.handler(createContext("models gpt-5.5 until available") as never);
    const blocked = await watchCommand.handler(
      createContext("models gpt-5.6 until available") as never,
    );
    expect(blocked.text).toContain("Cancel one");
  });

  it("explains baseline capture when creating URL changed watches", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });

    const created = await watchCommand.handler(
      createContext("url https://example.com changed") as never,
    );
    expect(created.text).toContain("baseline: first check captures");
  });

  it("creates and describes URL page-text watches", async () => {
    const store = createMemoryStore();
    const [watchCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });

    const help = await watchCommand.handler(createContext("help") as never);
    expect(help.text).toContain("page-text mode");

    const created = await watchCommand.handler(
      createContext('url https://example.com text contains "hello"') as never,
    );
    expect(created.text).toContain("URL text contains: hello");
    const id = [...store.watches.keys()][0];
    const shown = await watchCommand.handler(createContext(`show ${id}`) as never);
    expect(shown.text).toContain("- source: https://example.com/ (page text)");
  });

  it("creates GitHub PR watches and shows their source and condition", async () => {
    const store = createMemoryStore();
    const [watchCommand, watchesCommand] = createWatchesCommands({
      api: { runtime: {} as never },
      getStore: () => store,
      config: DEFAULT_WATCHES_CONFIG,
      now: () => 1_000,
    });

    const help = await watchCommand.handler(createContext("help") as never);
    expect(help.text).toContain("PR changed watches fire when the PR snapshot changes");
    expect(help.text).toContain("until checks fail");
    expect(help.text).toContain("until changes requested");

    const createdChecks = await watchCommand.handler(
      createContext(
        "github pr https://github.com/openclaw/openclaw/pull/123 until checks pass",
      ) as never,
    );
    expect(createdChecks.text).toContain("PR checks: openclaw/openclaw#123");

    const createdChanged = await watchCommand.handler(
      createContext("github pr openclaw/openclaw#124 changed") as never,
    );
    expect(createdChanged.text).toContain("baseline: first check captures the initial snapshot");

    const id = [...store.watches.keys()][0];
    const shown = await watchCommand.handler(createContext(`show ${id}`) as never);
    expect(shown.text).toContain("- type: GitHub PR");
    expect(shown.text).toContain("- source: openclaw/openclaw#123");
    expect(shown.text).toContain("- condition: checks pass");

    const listed = await watchesCommand.handler(createContext("") as never);
    expect(listed.text).toContain("PR checks: openclaw/openclaw#123");
    expect(listed.text).not.toContain("github_pr:");
  });
});
