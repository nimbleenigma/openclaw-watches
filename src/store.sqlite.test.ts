import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWatchesSqlitePath, WatchesStore } from "./store.sqlite.js";
import type { CreateWatchInput } from "./types.js";

const require = createRequire(import.meta.url);

async function withStore(run: (store: WatchesStore, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watches-store-"));
  const store = new WatchesStore(resolveWatchesSqlitePath(dir));
  try {
    await run(store, dir);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createInput(id: string, now = 1_000): CreateWatchInput {
  return {
    id,
    ownerKey: "telegram:alice",
    deliveryTarget: {
      sessionKey: "agent:main",
      channel: "telegram",
      to: "chat-1",
      senderId: "alice",
    },
    title: "URL contains: hello",
    kind: "url",
    source: { url: "https://example.com/" },
    condition: { type: "contains", text: "hello" },
    intervalSeconds: 60,
    nextCheckAt: now,
    expiresAt: now + 60_000,
    createdAt: now,
  };
}

describe("WatchesStore", () => {
  it("creates, lists, and records watch events", async () => {
    await withStore(async (store) => {
      const watch = store.createWatch(createInput("w_a"));
      expect(watch.ownerKey).toBe("telegram:alice");
      expect(store.countActiveForOwner("telegram:alice")).toBe(1);
      expect(store.listWatches({ ownerKey: "telegram:alice" })).toHaveLength(1);
      expect(store.listEvents("w_a").map((event) => event.eventType)).toEqual(["created"]);
    });
  });

  it("persists GitHub PR source and condition JSON without a schema migration", async () => {
    await withStore(async (store) => {
      const watch = store.createWatch({
        ...createInput("w_pr"),
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

      expect(watch.kind).toBe("github_pr");
      expect(store.getWatch("w_pr")).toMatchObject({
        kind: "github_pr",
        source: { owner: "openclaw", repo: "openclaw", number: 123 },
        condition: { type: "github_pr_checks_pass" },
      });
    });
  });

  it("claims due watches with leases and skips live claims", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput("w_a", 1_000));
      const first = store.claimDueWatches({
        now: 1_000,
        limit: 10,
        claimedBy: "worker-a",
        leaseMs: 5_000,
      });
      expect(first.map((watch) => watch.id)).toEqual(["w_a"]);
      const second = store.claimDueWatches({
        now: 2_000,
        limit: 10,
        claimedBy: "worker-b",
        leaseMs: 5_000,
      });
      expect(second).toEqual([]);
      const afterLease = store.claimDueWatches({
        now: 7_000,
        limit: 10,
        claimedBy: "worker-b",
        leaseMs: 5_000,
      });
      expect(afterLease.map((watch) => watch.id)).toEqual(["w_a"]);
    });
  });

  it("cancels only owner-scoped watches unless admin is allowed", async () => {
    await withStore(async (store) => {
      store.createWatch(createInput("w_a"));
      expect(
        store.cancelWatch({
          id: "w_a",
          ownerKey: "telegram:bob",
          now: 2_000,
        }),
      ).toBeUndefined();
      expect(
        store.cancelWatch({
          id: "w_a",
          ownerKey: "telegram:bob",
          now: 2_000,
          allowAnyOwner: true,
        })?.status,
      ).toBe("cancelled");
    });
  });

  it("migrates claim lease columns into an older watches table", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watches-migrate-"));
    try {
      const dbPath = resolveWatchesSqlitePath(dir);
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE watches (
          id TEXT PRIMARY KEY,
          owner_key TEXT NOT NULL,
          owner_session_key TEXT,
          owner_session_id TEXT,
          owner_channel TEXT,
          owner_to TEXT,
          owner_account_id TEXT,
          owner_thread_id TEXT,
          owner_sender_id TEXT,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_json TEXT NOT NULL,
          condition_json TEXT NOT NULL,
          status TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL,
          next_check_at INTEGER,
          expires_at INTEGER NOT NULL,
          last_checked_at INTEGER,
          last_result_hash TEXT,
          last_result_summary TEXT,
          error_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          triggered_at INTEGER,
          expired_at INTEGER,
          cancelled_at INTEGER
        );
      `);
      db.close();

      const store = new WatchesStore(dbPath);
      try {
        const columns = store.db
          .prepare("PRAGMA table_info(watches)")
          .all()
          .map((row) => (row as { name: string }).name);
        expect(columns).toContain("claimed_until");
        expect(columns).toContain("claimed_by");
        expect(columns).toContain("last_notified_hash");
        expect(columns).toContain("cooldown_until");
      } finally {
        store.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
