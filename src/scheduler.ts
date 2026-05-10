import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { PluginRuntime, PluginLogger } from "../api.js";
import { checkGitHubPrWatch } from "./check-github.js";
import { checkModelAvailability } from "./check-model.js";
import { checkUrlWatch } from "./check-url.js";
import type { WatchesConfig } from "./config.js";
import { WatchesStore } from "./store.sqlite.js";
import type { CheckOutcome, WatchEvaluator, WatchRecord } from "./types.js";

type Timer = ReturnType<typeof setTimeout>;

export type WatchesSchedulerOptions = {
  store: WatchesStore;
  runtime: Pick<PluginRuntime, "system">;
  cfg: OpenClawConfig;
  config: WatchesConfig;
  logger?: PluginLogger;
  now?: () => number;
  claimedBy?: string;
  evaluator?: WatchEvaluator;
};

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}

function backoffMs(errorCount: number): number {
  const attempts = Math.max(0, Math.min(errorCount, 8));
  return Math.min(60 * 60 * 1000, 60_000 * 2 ** attempts);
}

function nextIntervalAt(now: number, watch: WatchRecord): number {
  return now + Math.max(60, watch.intervalSeconds) * 1000;
}

function notificationTargetFromWatch(watch: WatchRecord) {
  return {
    sessionKey: watch.ownerSessionKey,
    channel: watch.ownerChannel,
    to: watch.ownerTo,
    accountId: watch.ownerAccountId,
    threadId: watch.ownerThreadId,
  };
}

function readGithubToken(config: WatchesConfig): string | undefined {
  const tokenEnv = config.githubTokenEnv.trim();
  return tokenEnv ? process.env[tokenEnv]?.trim() || undefined : undefined;
}

async function defaultEvaluator(
  watch: WatchRecord,
  context: { cfg: OpenClawConfig },
  config: WatchesConfig,
): Promise<CheckOutcome> {
  if (watch.kind === "model") {
    return await checkModelAvailability({ watch, cfg: context.cfg });
  }
  if (watch.kind === "url") {
    return await checkUrlWatch({
      watch,
      timeoutMs: config.urlTimeoutMs,
      maxBytes: config.urlMaxBytes,
    });
  }
  if (watch.kind === "github_pr") {
    return await checkGitHubPrWatch({
      watch,
      timeoutMs: config.urlTimeoutMs,
      token: readGithubToken(config),
    });
  }
  throw new Error(`Unsupported watch kind: ${(watch as { kind?: string }).kind ?? "unknown"}`);
}

export class WatchesScheduler {
  private timer: Timer | null = null;
  private running = false;
  private stopped = true;
  private readonly now: () => number;
  private readonly claimedBy: string;

  constructor(private readonly options: WatchesSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.claimedBy = options.claimedBy ?? `watches:${process.pid}`;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.tickAndReschedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<void> {
    const wasStopped = this.stopped;
    this.stopped = false;
    try {
      await this.tick();
    } finally {
      this.stopped = wasStopped;
    }
  }

  wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.tickAndReschedule();
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    const nextDueAt = this.options.store.getNextDueAt(now);
    const delay = nextDueAt == null ? 60_000 : Math.min(60_000, Math.max(0, nextDueAt - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tickAndReschedule();
    }, delay);
    this.timer.unref?.();
  }

  private async tickAndReschedule(): Promise<void> {
    try {
      await this.tick();
    } finally {
      this.scheduleNext();
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    try {
      const now = this.now();
      this.options.store.expireDueWatches(now);
      this.options.store.cleanupTerminal(now - this.options.config.retentionMs);
      const due = this.options.store.claimDueWatches({
        now,
        limit: this.options.config.maxConcurrentChecks,
        claimedBy: this.claimedBy,
        leaseMs: this.options.config.claimLeaseMs,
      });
      await Promise.all(due.map((watch) => this.processWatch(watch)));
    } finally {
      this.running = false;
    }
  }

  private async evaluate(watch: WatchRecord): Promise<CheckOutcome> {
    if (this.options.evaluator) {
      return await this.options.evaluator(watch, { cfg: this.options.cfg });
    }
    return await defaultEvaluator(watch, { cfg: this.options.cfg }, this.options.config);
  }

  private async processWatch(watch: WatchRecord): Promise<void> {
    try {
      const outcome = await this.evaluate(watch);
      const now = this.now();
      if (!outcome.triggered) {
        this.options.store.completeWatchCheck({
          id: watch.id,
          claimedBy: this.claimedBy,
          now,
          nextCheckAt: nextIntervalAt(now, watch),
          resultHash: outcome.resultHash,
          summary: outcome.summary,
          payload: outcome.payload,
        });
        return;
      }

      const notification = await this.options.runtime.system.notifyCapturedTarget({
        text: outcome.notification,
        target: notificationTargetFromWatch(watch),
        cfg: this.options.cfg,
        idempotencyKey: `watch:${watch.id}:trigger:${outcome.resultHash}`,
        reason: "watch-triggered",
      });
      if (!notification.delivered) {
        throw new Error(`notification not delivered: ${notification.error}`);
      }
      this.options.store.triggerWatch({
        id: watch.id,
        claimedBy: this.claimedBy,
        now,
        resultHash: outcome.resultHash,
        summary: outcome.summary,
        payload: outcome.payload,
      });
    } catch (error) {
      const now = this.now();
      const message = formatError(error);
      const nextErrorCount = watch.errorCount + 1;
      const terminal = nextErrorCount >= this.options.config.maxConsecutiveErrors;
      this.options.store.failWatchCheck({
        id: watch.id,
        claimedBy: this.claimedBy,
        now,
        nextCheckAt: terminal ? null : now + backoffMs(nextErrorCount),
        error: message,
        terminal,
      });
      if (terminal) {
        await this.options.runtime.system.notifyCapturedTarget({
          text: `Watch failed: ${watch.title}\n\n${message}`,
          target: notificationTargetFromWatch(watch),
          cfg: this.options.cfg,
          idempotencyKey: `watch:${watch.id}:failed`,
          reason: "watch-failed",
        });
      }
      this.options.logger?.warn(`watch check failed (${watch.id}): ${message}`);
    }
  }
}
