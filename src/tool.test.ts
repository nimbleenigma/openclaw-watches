import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginToolContext } from "../api.js";
import { DEFAULT_WATCHES_CONFIG } from "./config.js";
import { createWatchManagementService } from "./management.js";
import { createWatchManagementContextForTool, createWatchesManagementTool } from "./tool.js";
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

function createToolContext(sender = "alice"): OpenClawPluginToolContext {
  return {
    sessionKey: "agent:main",
    sessionId: "session-1",
    requesterSenderId: sender,
    deliveryContext: {
      channel: "telegram",
      to: "chat-1",
      accountId: "acct",
      threadId: "topic-1",
    },
  };
}

function createToolHarness(ctx = createToolContext()) {
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
  const tool = createWatchesManagementTool({ manager, ctx });
  return { store, wakeScheduler, manager, tool };
}

function details(result: { details?: unknown }): unknown {
  return result.details;
}

describe("watches_manage tool", () => {
  it("derives watch ownership and notification target from trusted tool context", () => {
    expect(createWatchManagementContextForTool(createToolContext())).toEqual({
      ownerKey: "telegram:alice",
      deliveryTarget: {
        sessionKey: "agent:main",
        sessionId: "session-1",
        channel: "telegram",
        to: "chat-1",
        accountId: "acct",
        threadId: "topic-1",
        senderId: "alice",
      },
    });
  });

  it("creates all supported watch kinds through the assistant tool", async () => {
    const { store, tool, wakeScheduler } = createToolHarness();

    const model = await tool.execute("tool-1", {
      action: "create_model_availability",
      model: "openai/gpt-5.5",
    });
    const contains = await tool.execute("tool-2", {
      action: "create_url_contains",
      url: "https://example.com",
      text: "Example Domain",
      content_mode: "text",
    });
    const matches = await tool.execute("tool-3", {
      action: "create_url_matches",
      url: "https://example.com/news",
      regex: "GPT-5\\.5",
    });
    const changed = await tool.execute("tool-4", {
      action: "create_url_changed",
      url: "https://example.com/news",
    });
    const prChecks = await tool.execute("tool-5", {
      action: "create_github_pr_checks",
      pr: "https://github.com/openclaw/openclaw/pull/123",
      interval_seconds: 300,
      expires_in_seconds: 7200,
    });
    const prState = await tool.execute("tool-6", {
      action: "create_github_pr_state",
      pr: "openclaw/openclaw#124",
    });

    expect(details(model)).toMatchObject({
      ok: true,
      watch: { id: "w_1" },
    });
    expect(details(contains)).toMatchObject({
      ok: true,
      watch: {
        title: "URL text contains: Example Domain",
        source: { contentMode: "text" },
        condition: { type: "contains", text: "Example Domain" },
      },
    });
    expect(details(matches)).toMatchObject({
      ok: true,
      watch: { condition: { type: "matches", pattern: "GPT-5\\.5", flags: "i" } },
    });
    expect(details(changed)).toMatchObject({
      ok: true,
      watch: { condition: { type: "changed" } },
    });
    expect(details(prChecks)).toMatchObject({
      ok: true,
      watch: {
        condition: { type: "github_pr_checks_pass" },
        source: { owner: "openclaw", repo: "openclaw", number: 123 },
        intervalSeconds: 300,
        expiresAt: 7_201_000,
      },
    });
    expect(details(prState)).toMatchObject({
      ok: true,
      watch: {
        condition: { type: "github_pr_state_changed" },
        source: { owner: "openclaw", repo: "openclaw", number: 124 },
      },
    });
    expect(store.watches.get("w_1")).toMatchObject({
      ownerKey: "telegram:alice",
      ownerSessionKey: "agent:main",
      ownerChannel: "telegram",
      ownerTo: "chat-1",
      ownerThreadId: "topic-1",
      ownerSenderId: "alice",
    });
    expect(wakeScheduler).toHaveBeenCalledTimes(6);
  });

  it("creates richer GitHub PR condition watches through the assistant tool", async () => {
    const { tool } = createToolHarness();

    const failed = await tool.execute("tool-1", {
      action: "create_github_pr_checks_failed",
      pr: "openclaw/openclaw#123",
    });
    const merged = await tool.execute("tool-2", {
      action: "create_github_pr_merged",
      pr: "openclaw/openclaw#123",
    });
    const approved = await tool.execute("tool-3", {
      action: "create_github_pr_approved",
      pr: "openclaw/openclaw#123",
    });
    const changesRequested = await tool.execute("tool-4", {
      action: "create_github_pr_changes_requested",
      pr: "openclaw/openclaw#123",
    });

    expect(details(failed)).toMatchObject({
      ok: true,
      watch: { condition: { type: "github_pr_checks_fail" } },
    });
    expect(details(merged)).toMatchObject({
      ok: true,
      watch: { condition: { type: "github_pr_merged" } },
    });
    expect(details(approved)).toMatchObject({
      ok: true,
      watch: { condition: { type: "github_pr_review_approved" } },
    });
    expect(details(changesRequested)).toMatchObject({
      ok: true,
      watch: { condition: { type: "github_pr_review_changes_requested" } },
    });
  });

  it("lists, shows, and cancels watches without crossing owner scope", async () => {
    const { manager, store, tool } = createToolHarness();
    const bobTool = createWatchesManagementTool({ manager, ctx: createToolContext("bob") });
    await tool.execute("tool-1", {
      action: "create_url_contains",
      url: "https://example.com",
      text: "hello",
    });

    const bobList = await bobTool.execute("tool-2", { action: "list", include_all: true });
    expect((details(bobList) as { watches: unknown[] }).watches).toEqual([]);
    const bobShow = await bobTool.execute("tool-3", { action: "show", watch_id: "w_1" });
    expect(details(bobShow)).toMatchObject({
      ok: false,
      error: "No watch found for w_1.",
    });

    const aliceList = await tool.execute("tool-4", { action: "list" });
    expect(
      (details(aliceList) as { watches: Array<{ id: string; status: string }> }).watches,
    ).toEqual([expect.objectContaining({ id: "w_1", status: "active" })]);
    const aliceShow = await tool.execute("tool-5", { action: "show", watch_id: "w_1" });
    expect(details(aliceShow)).toMatchObject({
      ok: true,
      watch: { id: "w_1" },
      events: [expect.objectContaining({ eventType: "created", watchId: "w_1" })],
    });

    const cancelled = await tool.execute("tool-6", { action: "cancel", watch_id: "w_1" });
    expect(details(cancelled)).toMatchObject({
      ok: true,
      finalStatus: "cancelled",
    });
    expect(store.watches.get("w_1")?.status).toBe("cancelled");
    const activeAfterCancel = await tool.execute("tool-7", { action: "list" });
    expect((details(activeAfterCancel) as { watches: unknown[] }).watches).toEqual([]);
    const allAfterCancel = await tool.execute("tool-8", { action: "list", include_all: true });
    expect((details(allAfterCancel) as { watches: Array<{ status: string }> }).watches).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });

  it("returns clear validation errors for invalid regex input", async () => {
    const { tool } = createToolHarness();
    const result = await tool.execute("tool-1", {
      action: "create_url_matches",
      url: "https://example.com",
      regex: "[unterminated",
    });

    expect(details(result)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Regex pattern is invalid"),
    });
  });

  it("returns clear validation errors for invalid URL content mode", async () => {
    const { tool } = createToolHarness();
    const result = await tool.execute("tool-1", {
      action: "create_url_contains",
      url: "https://example.com",
      text: "hello",
      content_mode: "rendered",
    });

    expect(details(result)).toMatchObject({
      ok: false,
      error: "content_mode must be raw or text",
    });
  });

  it("returns clear validation errors for invalid GitHub PR input", async () => {
    const { tool } = createToolHarness();
    const result = await tool.execute("tool-1", {
      action: "create_github_pr_checks",
      pr: "https://example.com/openclaw/openclaw/pull/1",
    });

    expect(details(result)).toMatchObject({
      ok: false,
      error: expect.stringContaining("GitHub PR must be"),
    });
  });
});
