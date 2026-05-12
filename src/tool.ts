import { Type } from "typebox";
import { jsonResult, type AnyAgentTool, type OpenClawPluginToolContext } from "../api.js";
import { getWatchHealth, type WatchHealth } from "./health.js";
import type { WatchManagementContext, WatchManagementService } from "./management.js";
import type { WatchCondition, WatchEventRecord, WatchRecord, WatchSource } from "./types.js";

type WatchToolAction =
  | "create_model_availability"
  | "create_url_contains"
  | "create_url_matches"
  | "create_url_changed"
  | "create_github_pr_checks"
  | "create_github_pr_checks_failed"
  | "create_github_pr_merged"
  | "create_github_pr_approved"
  | "create_github_pr_changes_requested"
  | "create_github_pr_state"
  | "health"
  | "list"
  | "show"
  | "cancel";

type WatchToolParams = {
  action?: WatchToolAction;
  model?: unknown;
  pr?: unknown;
  url?: unknown;
  text?: unknown;
  regex?: unknown;
  content_mode?: unknown;
  interval_seconds?: unknown;
  expires_in_seconds?: unknown;
  watch_id?: unknown;
  include_all?: unknown;
  limit?: unknown;
};

type WatchToolRecord = {
  id: string;
  title: string;
  kind: WatchRecord["kind"];
  source: WatchSource;
  condition: WatchCondition;
  status: WatchRecord["status"];
  intervalSeconds: number;
  nextCheckAt?: number;
  expiresAt: number;
  lastCheckedAt?: number;
  lastResultSummary?: string;
  lastError?: string;
  errorCount: number;
  health: WatchHealth;
  createdAt: number;
  updatedAt: number;
  triggeredAt?: number;
  expiredAt?: number;
  cancelledAt?: number;
};

type WatchToolEvent = {
  id: string;
  watchId: string;
  eventType: WatchEventRecord["eventType"];
  summary?: string;
  createdAt: number;
};

const WatchManagementToolSchema = Type.Object({
  action: Type.String({
    enum: [
      "create_model_availability",
      "create_url_contains",
      "create_url_matches",
      "create_url_changed",
      "create_github_pr_checks",
      "create_github_pr_checks_failed",
      "create_github_pr_merged",
      "create_github_pr_approved",
      "create_github_pr_changes_requested",
      "create_github_pr_state",
      "health",
      "list",
      "show",
      "cancel",
    ],
    description: "Watch management action.",
  }),
  model: Type.Optional(Type.String({ description: "Model or provider/model query." })),
  pr: Type.Optional(
    Type.String({
      description: "GitHub PR URL or owner/repo#number for create_github_pr_* actions.",
    }),
  ),
  url: Type.Optional(Type.String({ description: "HTTP or HTTPS URL to watch." })),
  text: Type.Optional(Type.String({ description: "Text for create_url_contains." })),
  regex: Type.Optional(Type.String({ description: "Regex pattern for create_url_matches." })),
  content_mode: Type.Optional(
    Type.String({
      enum: ["raw", "text"],
      description: "Optional URL content mode. Use text for readable page text extraction.",
    }),
  ),
  interval_seconds: Type.Optional(
    Type.Number({
      minimum: 60,
      maximum: 86400,
      description: "Optional per-watch polling interval in seconds.",
    }),
  ),
  expires_in_seconds: Type.Optional(
    Type.Number({
      minimum: 3600,
      maximum: 604800,
      description: "Optional per-watch lifetime in seconds.",
    }),
  ),
  watch_id: Type.Optional(Type.String({ description: "Watch id for show or cancel." })),
  include_all: Type.Optional(
    Type.Boolean({ description: "List terminal watches as well as active watches." }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum watches to return." })),
});

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireString(params: WatchToolParams, key: keyof WatchToolParams): string {
  const value = readTrimmedString(params[key]);
  if (!value) {
    throw new Error(`${key} required`);
  }
  return value;
}

function readLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 50;
  }
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function readUrlContentMode(value: unknown): "raw" | "text" | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === "raw" || value === "text") {
    return value;
  }
  throw new Error("content_mode must be raw or text");
}

function readSchedule(params: WatchToolParams) {
  const schedule: { intervalSeconds?: number; expiryMs?: number } = {};
  if (params.interval_seconds != null) {
    if (typeof params.interval_seconds !== "number" || !Number.isFinite(params.interval_seconds)) {
      throw new Error("interval_seconds must be a number");
    }
    schedule.intervalSeconds = Math.trunc(params.interval_seconds);
  }
  if (params.expires_in_seconds != null) {
    if (
      typeof params.expires_in_seconds !== "number" ||
      !Number.isFinite(params.expires_in_seconds)
    ) {
      throw new Error("expires_in_seconds must be a number");
    }
    schedule.expiryMs = Math.trunc(params.expires_in_seconds * 1000);
  }
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

function serializeWatch(watch: WatchRecord): WatchToolRecord {
  return {
    id: watch.id,
    title: watch.title,
    kind: watch.kind,
    source: watch.source,
    condition: watch.condition,
    status: watch.status,
    intervalSeconds: watch.intervalSeconds,
    nextCheckAt: watch.nextCheckAt,
    expiresAt: watch.expiresAt,
    lastCheckedAt: watch.lastCheckedAt,
    lastResultSummary: watch.lastResultSummary,
    lastError: watch.lastError,
    errorCount: watch.errorCount,
    health: getWatchHealth(watch),
    createdAt: watch.createdAt,
    updatedAt: watch.updatedAt,
    triggeredAt: watch.triggeredAt,
    expiredAt: watch.expiredAt,
    cancelledAt: watch.cancelledAt,
  };
}

function serializeEvent(event: WatchEventRecord): WatchToolEvent {
  return {
    id: event.id,
    watchId: event.watchId,
    eventType: event.eventType,
    summary: event.summary,
    createdAt: event.createdAt,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWatchManagementContextForTool(
  ctx: OpenClawPluginToolContext,
): WatchManagementContext {
  const delivery = ctx.deliveryContext;
  const channel = readTrimmedString(delivery?.channel) ?? readTrimmedString(ctx.messageChannel);
  const to = readTrimmedString(delivery?.to);
  const sessionKey = readTrimmedString(ctx.sessionKey);
  const sessionId = readTrimmedString(ctx.sessionId);
  const senderId = readTrimmedString(ctx.requesterSenderId);
  const accountId = readTrimmedString(delivery?.accountId) ?? readTrimmedString(ctx.agentAccountId);
  const agentId = readTrimmedString(ctx.agentId);

  let ownerKey: string;
  if (channel && senderId) {
    ownerKey = `${channel}:${senderId}`;
  } else if (sessionKey) {
    ownerKey = `session:${sessionKey}`;
  } else if (channel && to) {
    ownerKey = `${channel}:${to}`;
  } else if (sessionId) {
    ownerKey = `session-id:${sessionId}`;
  } else if (agentId) {
    ownerKey = `agent:${agentId}`;
  } else {
    ownerKey = "tool:unknown";
  }

  return {
    ownerKey,
    deliveryTarget: {
      sessionKey,
      sessionId,
      channel,
      to,
      accountId,
      threadId: delivery?.threadId,
      senderId,
    },
  };
}

export function createWatchesManagementTool(params: {
  manager: WatchManagementService;
  ctx: OpenClawPluginToolContext;
}): AnyAgentTool {
  const context = createWatchManagementContextForTool(params.ctx);
  return {
    name: "watches_manage",
    label: "Watches",
    description:
      "Create, list, show, and cancel temporary watches scoped to the active requester/session. Supports model availability, URL content/regex/change checks, and GitHub PR checks, merge, review, and snapshot watches.",
    parameters: WatchManagementToolSchema,
    async execute(_toolCallId, rawParams) {
      const raw = rawParams && typeof rawParams === "object" ? (rawParams as WatchToolParams) : {};
      const action = raw.action;
      try {
        switch (action) {
          case "create_model_availability": {
            const watch = params.manager.createModelAvailabilityWatch(context, {
              model: requireString(raw, "model"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_url_contains": {
            const watch = params.manager.createUrlContainsWatch(context, {
              url: requireString(raw, "url"),
              text: requireString(raw, "text"),
              contentMode: readUrlContentMode(raw.content_mode),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_url_matches": {
            const watch = params.manager.createUrlRegexWatch(context, {
              url: requireString(raw, "url"),
              regex: requireString(raw, "regex"),
              contentMode: readUrlContentMode(raw.content_mode),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_url_changed": {
            const watch = params.manager.createUrlChangedWatch(context, {
              url: requireString(raw, "url"),
              contentMode: readUrlContentMode(raw.content_mode),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_checks": {
            const watch = params.manager.createGitHubPrChecksWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_checks_failed": {
            const watch = params.manager.createGitHubPrChecksFailWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_merged": {
            const watch = params.manager.createGitHubPrMergedWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_approved": {
            const watch = params.manager.createGitHubPrApprovedWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_changes_requested": {
            const watch = params.manager.createGitHubPrChangesRequestedWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "create_github_pr_state": {
            const watch = params.manager.createGitHubPrStateWatch(context, {
              pr: requireString(raw, "pr"),
              schedule: readSchedule(raw),
            });
            return jsonResult({ ok: true, action, watch: serializeWatch(watch) });
          }
          case "list": {
            const watches = params.manager
              .listWatches(context, {
                includeAll: raw.include_all === true,
                limit: readLimit(raw.limit),
              })
              .map(serializeWatch);
            return jsonResult({ ok: true, action, watches });
          }
          case "health": {
            return jsonResult({
              ok: true,
              action,
              diagnostics: params.manager.getDiagnostics(context),
            });
          }
          case "show": {
            const watchId = requireString(raw, "watch_id");
            const watch = params.manager.showWatch(context, watchId);
            return jsonResult(
              watch
                ? {
                    ok: true,
                    action,
                    watch: serializeWatch(watch),
                    events: params.manager.showWatchEvents(context, watchId).map(serializeEvent),
                  }
                : { ok: false, action, error: `No watch found for ${watchId}.` },
            );
          }
          case "cancel": {
            const watchId = requireString(raw, "watch_id");
            const watch = params.manager.cancelWatch(context, watchId);
            return jsonResult(
              watch
                ? {
                    ok: true,
                    action,
                    watch: serializeWatch(watch),
                    finalStatus: watch.status,
                  }
                : { ok: false, action, error: `No watch found for ${watchId}.` },
            );
          }
          default:
            throw new Error("action required");
        }
      } catch (error) {
        return jsonResult({ ok: false, action: action ?? null, error: formatError(error) });
      }
    },
  };
}
