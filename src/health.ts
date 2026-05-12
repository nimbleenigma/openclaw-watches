import type { WatchRecord } from "./types.js";

export type WatchHealthState =
  | "pending"
  | "ok"
  | "degraded"
  | "overdue"
  | "triggered"
  | "expired"
  | "cancelled"
  | "failed";

export type WatchNotificationState = "delivered" | "not_triggered" | "unknown";

export type WatchHealth = {
  state: WatchHealthState;
  summary: string;
  notification: WatchNotificationState;
};

const OVERDUE_GRACE_MS = 60_000;

function notificationState(watch: WatchRecord): WatchNotificationState {
  if (
    watch.lastNotifiedHash &&
    watch.lastResultHash &&
    watch.lastNotifiedHash === watch.lastResultHash
  ) {
    return "delivered";
  }
  if (!watch.lastNotifiedHash) {
    return "not_triggered";
  }
  return "unknown";
}

export function getWatchHealth(watch: WatchRecord, now = Date.now()): WatchHealth {
  const notification = notificationState(watch);
  if (watch.status !== "active") {
    return {
      state: watch.status,
      summary: watch.status === "failed" ? "terminal failure" : watch.status,
      notification,
    };
  }

  if (watch.lastError) {
    return {
      state: "degraded",
      summary:
        watch.errorCount > 0
          ? `last check failed; retrying (errors: ${watch.errorCount})`
          : "last check failed; retrying",
      notification,
    };
  }

  if (!watch.lastCheckedAt) {
    return { state: "pending", summary: "waiting for first check", notification };
  }

  if (watch.nextCheckAt && watch.nextCheckAt < now - OVERDUE_GRACE_MS) {
    return { state: "overdue", summary: "next check is overdue", notification };
  }

  return { state: "ok", summary: "checking normally", notification };
}
