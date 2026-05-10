import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export type WatchKind = "model" | "url" | "github_pr";
export type WatchStatus = "active" | "triggered" | "expired" | "cancelled" | "failed";
export type WatchEventType =
  | "created"
  | "checked"
  | "triggered"
  | "expired"
  | "failed"
  | "cancelled";

export type WatchDeliveryTarget = {
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  senderId?: string;
};

export type ModelWatchSource = {
  query: string;
  provider?: string;
  model?: string;
};

export type UrlWatchSource = {
  url: string;
  contentMode?: "raw" | "text";
};

export type GitHubPrWatchSource = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  query: string;
};

export type WatchSource = ModelWatchSource | UrlWatchSource | GitHubPrWatchSource;

export type WatchCondition =
  | { type: "available" }
  | { type: "contains"; text: string; caseSensitive?: boolean }
  | { type: "changed" }
  | { type: "matches"; pattern: string; flags: string }
  | { type: "github_pr_checks_pass" }
  | { type: "github_pr_checks_fail" }
  | { type: "github_pr_merged" }
  | { type: "github_pr_review_approved" }
  | { type: "github_pr_review_changes_requested" }
  | { type: "github_pr_state_changed" };

export type WatchScheduleSpec = {
  intervalSeconds?: number;
  expiryMs?: number;
};

export type WatchRecord = {
  id: string;
  ownerKey: string;
  ownerSessionKey?: string;
  ownerSessionId?: string;
  ownerChannel?: string;
  ownerTo?: string;
  ownerAccountId?: string;
  ownerThreadId?: string | number;
  ownerSenderId?: string;
  title: string;
  kind: WatchKind;
  source: WatchSource;
  condition: WatchCondition;
  status: WatchStatus;
  intervalSeconds: number;
  nextCheckAt?: number;
  expiresAt: number;
  lastCheckedAt?: number;
  lastResultHash?: string;
  lastResultSummary?: string;
  lastNotifiedHash?: string;
  cooldownUntil?: number;
  errorCount: number;
  lastError?: string;
  claimedUntil?: number;
  claimedBy?: string;
  createdAt: number;
  updatedAt: number;
  triggeredAt?: number;
  expiredAt?: number;
  cancelledAt?: number;
};

export type WatchEventRecord = {
  id: string;
  watchId: string;
  eventType: WatchEventType;
  resultHash?: string;
  summary?: string;
  payload?: unknown;
  createdAt: number;
};

export type CreateWatchInput = {
  id: string;
  ownerKey: string;
  deliveryTarget: WatchDeliveryTarget;
  title: string;
  kind: WatchKind;
  source: WatchSource;
  condition: WatchCondition;
  intervalSeconds: number;
  nextCheckAt: number;
  expiresAt: number;
  createdAt: number;
};

export type CheckOutcome =
  | {
      triggered: false;
      resultHash: string;
      summary: string;
      payload?: unknown;
    }
  | {
      triggered: true;
      resultHash: string;
      summary: string;
      notification: string;
      payload?: unknown;
    };

export type WatchEvaluator = (
  watch: WatchRecord,
  context: {
    cfg: OpenClawConfig;
    signal?: AbortSignal;
  },
) => Promise<CheckOutcome>;
