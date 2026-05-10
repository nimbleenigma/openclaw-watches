import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  CreateWatchInput,
  WatchCondition,
  WatchEventRecord,
  WatchEventType,
  WatchKind,
  WatchRecord,
  WatchSource,
  WatchStatus,
} from "./types.js";

const require = createRequire(import.meta.url);
const WATCHES_DIR_MODE = 0o700;
const WATCHES_FILE_MODE = 0o600;
const WATCHES_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

type WatchRow = {
  id: string;
  owner_key: string;
  owner_session_key: string | null;
  owner_session_id: string | null;
  owner_channel: string | null;
  owner_to: string | null;
  owner_account_id: string | null;
  owner_thread_id: string | null;
  owner_sender_id: string | null;
  title: string;
  kind: WatchKind;
  source_json: string;
  condition_json: string;
  status: WatchStatus;
  interval_seconds: number | bigint;
  next_check_at: number | bigint | null;
  expires_at: number | bigint;
  last_checked_at: number | bigint | null;
  last_result_hash: string | null;
  last_result_summary: string | null;
  last_notified_hash: string | null;
  cooldown_until: number | bigint | null;
  error_count: number | bigint;
  last_error: string | null;
  claimed_until: number | bigint | null;
  claimed_by: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  triggered_at: number | bigint | null;
  expired_at: number | bigint | null;
  cancelled_at: number | bigint | null;
};

type WatchEventRow = {
  id: string;
  watch_id: string;
  event_type: WatchEventType;
  result_hash: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: number | bigint;
};

type TableInfoRow = {
  name: string;
};

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite support is unavailable in this Node runtime. ${message}`, {
      cause: error,
    });
  }
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonOptional(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function ensureParentDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: WATCHES_DIR_MODE });
  try {
    fs.chmodSync(dir, WATCHES_DIR_MODE);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

function chmodSqliteFiles(dbPath: string): void {
  for (const suffix of WATCHES_SIDECAR_SUFFIXES) {
    const filePath = `${dbPath}${suffix}`;
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      fs.chmodSync(filePath, WATCHES_FILE_MODE);
    } catch {
      // Best effort on filesystems that do not support chmod.
    }
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return rows.some((row) => row.name === column);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function openDatabase(dbPath: string): DatabaseSync {
  ensureParentDir(dbPath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
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
      last_notified_hash TEXT,
      cooldown_until INTEGER,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_until INTEGER,
      claimed_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      triggered_at INTEGER,
      expired_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS watch_events (
      id TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      result_hash TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
    );
  `);
  ensureColumn(db, "watches", "claimed_until", "INTEGER");
  ensureColumn(db, "watches", "claimed_by", "TEXT");
  ensureColumn(db, "watches", "last_notified_hash", "TEXT");
  ensureColumn(db, "watches", "cooldown_until", "INTEGER");
  db.exec(`
    CREATE INDEX IF NOT EXISTS watches_status_next_idx ON watches(status, next_check_at);
    CREATE INDEX IF NOT EXISTS watches_owner_status_idx ON watches(owner_key, status);
    CREATE INDEX IF NOT EXISTS watches_expires_idx ON watches(expires_at);
    CREATE INDEX IF NOT EXISTS watches_claimed_idx ON watches(claimed_until);
    CREATE INDEX IF NOT EXISTS watch_events_watch_created_idx ON watch_events(watch_id, created_at);
  `);
  chmodSqliteFiles(dbPath);
  return db;
}

function rowToWatch(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    ownerKey: row.owner_key,
    ownerSessionKey: row.owner_session_key ?? undefined,
    ownerSessionId: row.owner_session_id ?? undefined,
    ownerChannel: row.owner_channel ?? undefined,
    ownerTo: row.owner_to ?? undefined,
    ownerAccountId: row.owner_account_id ?? undefined,
    ownerThreadId: row.owner_thread_id ?? undefined,
    ownerSenderId: row.owner_sender_id ?? undefined,
    title: row.title,
    kind: row.kind,
    source: parseJson(row.source_json) as WatchSource,
    condition: parseJson(row.condition_json) as WatchCondition,
    status: row.status,
    intervalSeconds: normalizeNumber(row.interval_seconds) ?? 0,
    nextCheckAt: normalizeNumber(row.next_check_at),
    expiresAt: normalizeNumber(row.expires_at) ?? 0,
    lastCheckedAt: normalizeNumber(row.last_checked_at),
    lastResultHash: row.last_result_hash ?? undefined,
    lastResultSummary: row.last_result_summary ?? undefined,
    lastNotifiedHash: row.last_notified_hash ?? undefined,
    cooldownUntil: normalizeNumber(row.cooldown_until),
    errorCount: normalizeNumber(row.error_count) ?? 0,
    lastError: row.last_error ?? undefined,
    claimedUntil: normalizeNumber(row.claimed_until),
    claimedBy: row.claimed_by ?? undefined,
    createdAt: normalizeNumber(row.created_at) ?? 0,
    updatedAt: normalizeNumber(row.updated_at) ?? 0,
    triggeredAt: normalizeNumber(row.triggered_at),
    expiredAt: normalizeNumber(row.expired_at),
    cancelledAt: normalizeNumber(row.cancelled_at),
  };
}

function rowToEvent(row: WatchEventRow): WatchEventRecord {
  return {
    id: row.id,
    watchId: row.watch_id,
    eventType: row.event_type,
    resultHash: row.result_hash ?? undefined,
    summary: row.summary ?? undefined,
    payload: parseJsonOptional(row.payload_json),
    createdAt: normalizeNumber(row.created_at) ?? 0,
  };
}

function bindCreateWatch(input: CreateWatchInput) {
  return {
    id: input.id,
    owner_key: input.ownerKey,
    owner_session_key: input.deliveryTarget.sessionKey ?? null,
    owner_session_id: input.deliveryTarget.sessionId ?? null,
    owner_channel: input.deliveryTarget.channel ?? null,
    owner_to: input.deliveryTarget.to ?? null,
    owner_account_id: input.deliveryTarget.accountId ?? null,
    owner_thread_id:
      input.deliveryTarget.threadId != null ? String(input.deliveryTarget.threadId) : null,
    owner_sender_id: input.deliveryTarget.senderId ?? null,
    title: input.title,
    kind: input.kind,
    source_json: serializeJson(input.source),
    condition_json: serializeJson(input.condition),
    status: "active",
    interval_seconds: input.intervalSeconds,
    next_check_at: input.nextCheckAt,
    expires_at: input.expiresAt,
    error_count: 0,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

export function resolveWatchesSqlitePath(stateDir: string): string {
  return path.join(stateDir, "watches", "watches.sqlite");
}

export class WatchesStore {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEvent(params: {
    watchId: string;
    eventType: WatchEventType;
    resultHash?: string;
    summary?: string;
    payload?: unknown;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO watch_events (
          id, watch_id, event_type, result_hash, summary, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        params.watchId,
        params.eventType,
        params.resultHash ?? null,
        params.summary ?? null,
        params.payload == null ? null : serializeJson(params.payload),
        params.now,
      );
  }

  createWatch(input: CreateWatchInput): WatchRecord {
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO watches (
            id, owner_key, owner_session_key, owner_session_id, owner_channel, owner_to,
            owner_account_id, owner_thread_id, owner_sender_id, title, kind, source_json,
            condition_json, status, interval_seconds, next_check_at, expires_at, error_count,
            created_at, updated_at
          ) VALUES (
            @id, @owner_key, @owner_session_key, @owner_session_id, @owner_channel, @owner_to,
            @owner_account_id, @owner_thread_id, @owner_sender_id, @title, @kind, @source_json,
            @condition_json, @status, @interval_seconds, @next_check_at, @expires_at,
            @error_count, @created_at, @updated_at
          )`,
        )
        .run(bindCreateWatch(input));
      this.insertEvent({
        watchId: input.id,
        eventType: "created",
        summary: input.title,
        now: input.createdAt,
      });
      const created = this.getWatch(input.id);
      if (!created) {
        throw new Error("Created watch could not be read back");
      }
      return created;
    });
  }

  getWatch(id: string): WatchRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM watches WHERE id = ?`).get(id) as
      | WatchRow
      | undefined;
    return row ? rowToWatch(row) : undefined;
  }

  listWatches(
    params: {
      ownerKey?: string;
      includeAll?: boolean;
      limit?: number;
    } = {},
  ): WatchRecord[] {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const rows = this.db
      .prepare(
        `SELECT * FROM watches
         WHERE (@owner_key IS NULL OR owner_key = @owner_key)
           AND (@include_all = 1 OR status = 'active')
         ORDER BY created_at DESC, id ASC
         LIMIT @limit`,
      )
      .all({
        owner_key: params.ownerKey ?? null,
        include_all: params.includeAll ? 1 : 0,
        limit,
      }) as WatchRow[];
    return rows.map(rowToWatch);
  }

  countActiveForOwner(ownerKey: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM watches WHERE owner_key = ? AND status = 'active'`)
      .get(ownerKey) as { count: number | bigint } | undefined;
    return normalizeNumber(row?.count ?? null) ?? 0;
  }

  cancelWatch(params: {
    id: string;
    ownerKey?: string;
    now: number;
    allowAnyOwner?: boolean;
  }): WatchRecord | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM watches
           WHERE id = @id
             AND (@allow_any_owner = 1 OR owner_key = @owner_key)`,
        )
        .get({
          id: params.id,
          owner_key: params.ownerKey ?? "",
          allow_any_owner: params.allowAnyOwner ? 1 : 0,
        }) as WatchRow | undefined;
      if (!row) {
        return undefined;
      }
      if (row.status === "active") {
        this.db
          .prepare(
            `UPDATE watches
             SET status = 'cancelled',
                 cancelled_at = @now,
                 next_check_at = NULL,
                 claimed_until = NULL,
                 claimed_by = NULL,
                 updated_at = @now
             WHERE id = @id`,
          )
          .run({ id: params.id, now: params.now });
        this.insertEvent({
          watchId: params.id,
          eventType: "cancelled",
          summary: "Watch cancelled.",
          now: params.now,
        });
      }
      return this.getWatch(params.id);
    });
  }

  expireDueWatches(now: number): WatchRecord[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM watches WHERE status = 'active' AND expires_at <= ?`)
        .all(now) as WatchRow[];
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE watches
             SET status = 'expired',
                 expired_at = @now,
                 next_check_at = NULL,
                 claimed_until = NULL,
                 claimed_by = NULL,
                 updated_at = @now
             WHERE id = @id`,
          )
          .run({ id: row.id, now });
        this.insertEvent({
          watchId: row.id,
          eventType: "expired",
          summary: "Watch expired.",
          now,
        });
      }
      return rows.map(rowToWatch);
    });
  }

  claimDueWatches(params: {
    now: number;
    limit: number;
    claimedBy: string;
    leaseMs: number;
  }): WatchRecord[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM watches
           WHERE status = 'active'
             AND next_check_at IS NOT NULL
             AND next_check_at <= @now
             AND expires_at > @now
             AND (cooldown_until IS NULL OR cooldown_until <= @now)
             AND (claimed_until IS NULL OR claimed_until <= @now)
           ORDER BY next_check_at ASC, id ASC
           LIMIT @limit`,
        )
        .all({ now: params.now, limit: Math.max(1, params.limit) }) as WatchRow[];
      const claimed: WatchRecord[] = [];
      for (const row of rows) {
        const result = this.db
          .prepare(
            `UPDATE watches
             SET claimed_until = @claimed_until,
                 claimed_by = @claimed_by,
                 updated_at = @now
             WHERE id = @id
               AND status = 'active'
               AND (claimed_until IS NULL OR claimed_until <= @now)`,
          )
          .run({
            id: row.id,
            now: params.now,
            claimed_until: params.now + params.leaseMs,
            claimed_by: params.claimedBy,
          });
        if (result.changes > 0) {
          const next = this.getWatch(row.id);
          if (next) {
            claimed.push(next);
          }
        }
      }
      return claimed;
    });
  }

  completeWatchCheck(params: {
    id: string;
    claimedBy: string;
    now: number;
    nextCheckAt: number;
    resultHash: string;
    summary: string;
    payload?: unknown;
  }): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE watches
           SET last_checked_at = @now,
               last_result_hash = @result_hash,
               last_result_summary = @summary,
               error_count = 0,
               last_error = NULL,
               next_check_at = @next_check_at,
               claimed_until = NULL,
               claimed_by = NULL,
               updated_at = @now
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`,
        )
        .run({
          id: params.id,
          claimed_by: params.claimedBy,
          now: params.now,
          next_check_at: params.nextCheckAt,
          result_hash: params.resultHash,
          summary: params.summary,
        });
      this.insertEvent({
        watchId: params.id,
        eventType: "checked",
        resultHash: params.resultHash,
        summary: params.summary,
        payload: params.payload,
        now: params.now,
      });
    });
  }

  triggerWatch(params: {
    id: string;
    claimedBy: string;
    now: number;
    resultHash: string;
    summary: string;
    payload?: unknown;
  }): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE watches
           SET status = 'triggered',
               triggered_at = @now,
               last_checked_at = @now,
               last_result_hash = @result_hash,
               last_result_summary = @summary,
               last_notified_hash = @result_hash,
               next_check_at = NULL,
               error_count = 0,
               last_error = NULL,
               claimed_until = NULL,
               claimed_by = NULL,
               updated_at = @now
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`,
        )
        .run({
          id: params.id,
          claimed_by: params.claimedBy,
          now: params.now,
          result_hash: params.resultHash,
          summary: params.summary,
        });
      this.insertEvent({
        watchId: params.id,
        eventType: "triggered",
        resultHash: params.resultHash,
        summary: params.summary,
        payload: params.payload,
        now: params.now,
      });
    });
  }

  failWatchCheck(params: {
    id: string;
    claimedBy: string;
    now: number;
    nextCheckAt: number | null;
    error: string;
    terminal: boolean;
  }): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE watches
           SET status = CASE WHEN @terminal = 1 THEN 'failed' ELSE status END,
               last_checked_at = @now,
               last_error = @error,
               error_count = error_count + 1,
               next_check_at = @next_check_at,
               claimed_until = NULL,
               claimed_by = NULL,
               updated_at = @now
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`,
        )
        .run({
          id: params.id,
          claimed_by: params.claimedBy,
          now: params.now,
          error: params.error,
          next_check_at: params.nextCheckAt,
          terminal: params.terminal ? 1 : 0,
        });
      this.insertEvent({
        watchId: params.id,
        eventType: "failed",
        summary: params.error,
        now: params.now,
      });
    });
  }

  getNextDueAt(now: number): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(next_check_at) AS next_due
         FROM watches
         WHERE status = 'active'
           AND next_check_at IS NOT NULL
           AND expires_at > @now
           AND (cooldown_until IS NULL OR cooldown_until <= @now)
           AND (claimed_until IS NULL OR claimed_until <= @now)`,
      )
      .get({ now }) as { next_due: number | bigint | null } | undefined;
    return normalizeNumber(row?.next_due ?? null);
  }

  listEvents(watchId: string): WatchEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM watch_events WHERE watch_id = ? ORDER BY created_at ASC, id ASC`)
      .all(watchId) as WatchEventRow[];
    return rows.map(rowToEvent);
  }

  cleanupTerminal(before: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM watches
         WHERE status IN ('triggered', 'expired', 'cancelled', 'failed')
           AND updated_at < ?`,
      )
      .run(before);
    return Number(result.changes ?? 0);
  }
}
