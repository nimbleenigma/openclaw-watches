import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "../api.js";
import { formatGitHubPrRef } from "./github-pr.js";
import { getWatchHealth } from "./health.js";
import {
  createWatchManagementService,
  type WatchManagementDeps,
  type WatchManagementContext,
  type WatchDiagnostics,
} from "./management.js";
import { parseWatchCommand, parseWatchesCommand } from "./parse.js";
import type {
  UrlWatchSource,
  WatchCondition,
  WatchEventRecord,
  WatchRecord,
  WatchSource,
  WatchStatus,
} from "./types.js";

export type WatchesCommandDeps = WatchManagementDeps & {
  api: Pick<OpenClawPluginApi, "runtime">;
};

export function resolveWatchOwnerKey(ctx: PluginCommandContext): string {
  const sender = ctx.senderId?.trim();
  if (sender) {
    return `${ctx.channel}:${sender}`;
  }
  const from = ctx.from?.trim();
  if (from) {
    return `${ctx.channel}:${from}`;
  }
  const sessionKey = ctx.sessionKey?.trim();
  if (sessionKey) {
    return `session:${sessionKey}`;
  }
  return `channel:${ctx.channel}`;
}

function isAdminContext(ctx: PluginCommandContext): boolean {
  return ctx.gatewayClientScopes?.includes("operator.admin") === true;
}

function captureDeliveryTarget(ctx: PluginCommandContext) {
  return {
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    channel: ctx.channel,
    to: ctx.from ?? ctx.to,
    accountId: ctx.accountId,
    threadId: ctx.messageThreadId,
    senderId: ctx.senderId,
  };
}

function createManagementContext(ctx: PluginCommandContext): WatchManagementContext {
  return {
    ownerKey: resolveWatchOwnerKey(ctx),
    deliveryTarget: captureDeliveryTarget(ctx),
    allowAnyOwner: isAdminContext(ctx),
  };
}

function formatCancelResult(cancelled: WatchRecord | undefined, id: string): string {
  if (!cancelled) {
    return `No watch found for ${id}.`;
  }
  if (cancelled.status !== "cancelled") {
    return (
      `Watch ${cancelled.id} was not cancelled.\n` +
      `- final status: ${cancelled.status}\n` +
      `- ${cancelled.title}`
    );
  }
  return `Watch ${cancelled.id} cancelled.\n- final status: cancelled\n- ${cancelled.title}`;
}

function formatManagementError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatTimestamp(value?: number): string {
  return value ? new Date(value).toISOString() : "(none)";
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) {
    return "now";
  }
  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const;
  for (const [label, unitMs] of units) {
    if (abs >= unitMs || label === "s") {
      return `${Math.max(1, Math.round(abs / unitMs))}${label}`;
    }
  }
  return "0s";
}

function formatRelativeTime(value: number | undefined, now = Date.now()): string {
  if (!value) {
    return "(none)";
  }
  return `${formatTimestamp(value)} (${formatRelativeOnly(value, now)})`;
}

function formatRelativeOnly(value: number | undefined, now = Date.now()): string {
  if (!value) {
    return "(none)";
  }
  const delta = value - now;
  const duration = formatDuration(delta);
  if (duration === "now") {
    return "now";
  }
  return delta >= 0 ? `in ${duration}` : `${duration} ago`;
}

function compactText(value: string, maxChars = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isUrlSource(source: WatchSource): source is UrlWatchSource {
  return "url" in source && !("owner" in source);
}

function formatWatchSource(kind: WatchRecord["kind"], source: WatchSource): string {
  if (kind === "url" && isUrlSource(source)) {
    return source.contentMode === "text" ? `${source.url} (page text)` : source.url;
  }
  if (kind === "model" && "query" in source) {
    return source.query;
  }
  if (kind === "github_pr" && "owner" in source) {
    return formatGitHubPrRef(source);
  }
  return "(unknown)";
}

function formatWatchType(kind: WatchRecord["kind"]): string {
  switch (kind) {
    case "github_pr":
      return "GitHub PR";
    case "model":
      return "model";
    case "url":
      return "URL";
  }
  return "watch";
}

function formatWatchCondition(condition: WatchCondition): string {
  switch (condition.type) {
    case "available":
      return "available";
    case "changed":
      return "changed";
    case "contains":
      return `contains "${condition.text}"`;
    case "matches":
      return `matches /${condition.pattern}/${condition.flags}`;
    case "github_pr_checks_pass":
      return "checks pass";
    case "github_pr_checks_fail":
      return "checks fail";
    case "github_pr_merged":
      return "merged";
    case "github_pr_review_approved":
      return "approved";
    case "github_pr_review_changes_requested":
      return "changes requested";
    case "github_pr_state_changed":
      return "snapshot changed";
  }
  return "(unknown)";
}

function formatStatusPrefix(status: WatchStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    case "triggered":
      return "triggered";
  }
  return status;
}

function formatWatchListItem(watch: WatchRecord, now = Date.now()): string {
  const health = getWatchHealth(watch, now);
  const lines = [
    `${watch.id}  ${formatStatusPrefix(watch.status)}  health: ${health.state}`,
    `  ${watch.title}`,
    `  Health: ${health.summary}`,
  ];
  if (watch.status === "active") {
    lines.push(
      `  Next: ${formatRelativeOnly(watch.nextCheckAt, now)} | Expires: ${formatRelativeOnly(
        watch.expiresAt,
        now,
      )}`,
    );
  }
  const lastResult = watch.lastResultSummary
    ? `${compactText(watch.lastResultSummary, 96)} (${formatRelativeOnly(watch.lastCheckedAt, now)})`
    : "none";
  lines.push(`  Last: ${lastResult}`);
  if (watch.lastError) {
    lines.push(`  Error: ${compactText(watch.lastError, 96)} (count: ${watch.errorCount})`);
  }
  if (health.notification === "delivered") {
    lines.push("  Notification: delivered");
  }
  return lines.join("\n");
}

function formatWatchList(title: string, watches: WatchRecord[], now = Date.now()): string {
  return [
    `${title}: ${watches.length}`,
    ...watches.map((watch) => formatWatchListItem(watch, now)),
  ].join("\n\n");
}

function formatCountLine(label: string, counts: Record<string, number>): string {
  const rendered = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
  return `- ${label}: ${rendered || "none"}`;
}

function formatDiagnosticFailure(
  failure: WatchDiagnostics["recentFailures"][number],
  now: number,
): string {
  const checked = failure.lastCheckedAt
    ? ` | checked ${formatRelativeOnly(failure.lastCheckedAt, now)}`
    : "";
  const next = failure.nextCheckAt ? ` | next ${formatRelativeOnly(failure.nextCheckAt, now)}` : "";
  return `- ${failure.id} ${failure.status} ${failure.title} | errors ${failure.errorCount}${checked}${next}: ${compactText(
    failure.lastError,
    120,
  )}`;
}

function formatWatchDiagnostics(diagnostics: WatchDiagnostics): string {
  const now = diagnostics.generatedAt;
  const lines = [
    "Watches health",
    `- scope: ${diagnostics.scope}`,
    `- total watches: ${diagnostics.total}${diagnostics.truncated ? "+" : ""}`,
    formatCountLine("status", diagnostics.byStatus),
    formatCountLine("type", diagnostics.byKind),
    `- active: ${diagnostics.active.total}`,
    `- scheduler pressure: due ${diagnostics.active.due}, overdue ${diagnostics.active.overdue}, leased ${diagnostics.active.leased}, stale leases ${diagnostics.active.staleLeases}, cooling down ${diagnostics.active.coolingDown}`,
    `- active health: ok ${diagnostics.active.ok}, pending ${diagnostics.active.pendingFirstCheck}, degraded ${diagnostics.active.degraded}, with errors ${diagnostics.active.withErrors}`,
    `- next due: ${formatRelativeTime(diagnostics.nextDueAt, now)}`,
    `- oldest overdue: ${formatRelativeTime(diagnostics.oldestOverdueAt, now)}`,
    `- oldest stale lease: ${formatRelativeTime(diagnostics.oldestStaleLeaseAt, now)}`,
    `- delivered notifications: active ${diagnostics.notifications.activeDelivered}, terminal ${diagnostics.notifications.terminalDelivered}, unknown ${diagnostics.notifications.unknown}`,
  ];
  if (diagnostics.recentFailures.length > 0) {
    lines.push(
      "",
      "Recent failures:",
      ...diagnostics.recentFailures.map((failure) => formatDiagnosticFailure(failure, now)),
    );
  }
  return lines.join("\n");
}

function formatTerminalTimestamp(watch: WatchRecord): string | undefined {
  switch (watch.status) {
    case "cancelled":
      return `- cancelled: ${formatTimestamp(watch.cancelledAt)}`;
    case "expired":
      return `- expired: ${formatTimestamp(watch.expiredAt)}`;
    case "failed":
      return "- failed: terminal failure";
    case "triggered":
      return `- triggered: ${formatTimestamp(watch.triggeredAt)}`;
    case "active":
      return undefined;
  }
  return undefined;
}

function formatWatchEvent(event: WatchEventRecord): string {
  const summary = event.summary ? ` | ${compactText(event.summary, 120)}` : "";
  return `- ${formatTimestamp(event.createdAt)} | ${event.eventType}${summary}`;
}

function formatWatchDetails(
  watch: WatchRecord,
  events: WatchEventRecord[] = [],
  now = Date.now(),
): string {
  const health = getWatchHealth(watch, now);
  const lines = [
    `Watch ${watch.id}`,
    `- status: ${watch.status}`,
    `- health: ${health.state} - ${health.summary}`,
    `- title: ${watch.title}`,
    `- type: ${formatWatchType(watch.kind)}`,
    `- source: ${formatWatchSource(watch.kind, watch.source)}`,
    `- condition: ${formatWatchCondition(watch.condition)}`,
    `- interval: ${watch.intervalSeconds}s`,
    `- next check: ${formatRelativeTime(watch.nextCheckAt, now)}`,
    `- expires: ${formatRelativeTime(watch.expiresAt, now)}`,
    `- created: ${formatTimestamp(watch.createdAt)}`,
    `- updated: ${formatTimestamp(watch.updatedAt)}`,
    `- last check: ${formatTimestamp(watch.lastCheckedAt)}`,
    `- last result: ${watch.lastResultSummary ? compactText(watch.lastResultSummary, 180) : "none"}`,
    `- notification: ${health.notification}`,
    `- errors: ${watch.errorCount}`,
  ];
  const terminalTimestamp = formatTerminalTimestamp(watch);
  if (terminalTimestamp) {
    lines.push(terminalTimestamp);
  }
  if (watch.lastError) {
    lines.push(`- last error: ${compactText(watch.lastError, 180)}`);
  }
  if (events.length > 0) {
    lines.push("", "Recent events:", ...events.map(formatWatchEvent));
  }
  return lines.join("\n");
}

function usage(): string {
  return [
    "Usage:",
    "/watch models <model> until available",
    '/watch url <url> contains "<text>"',
    "/watch url <url> changed",
    "/watch url <url> text changed",
    '/watch url <url> matches "<regex>"',
    "Optional schedule suffix: every 5m for 6h",
    'Add text for quieter page-text mode, e.g. /watch url <url> text contains "<text>"',
    "/watch github pr <url|owner/repo#number> until checks pass",
    "/watch github pr <url|owner/repo#number> until checks fail",
    "/watch github pr <url|owner/repo#number> until merged",
    "/watch github pr <url|owner/repo#number> until approved",
    "/watch github pr <url|owner/repo#number> until changes requested",
    "/watch github pr <url|owner/repo#number> changed",
    "  (PR changed watches fire when the PR snapshot changes: state, draft, merged state, head, checks, or reviews.)",
    "/watches",
    "/watches all",
    "/watches health",
    "/watches show <id>",
    "/watches cancel <id>",
  ].join("\n");
}

function commandNow(deps: WatchManagementDeps): number {
  return deps.now?.() ?? Date.now();
}

function createWatchCommand(deps: WatchesCommandDeps): OpenClawPluginCommandDefinition {
  const manager = createWatchManagementService(deps);
  return {
    name: "watch",
    description: "Create or cancel a temporary watch.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseWatchCommand(ctx.args);
      if (parsed.action === "help") {
        return { text: usage() };
      }
      if (parsed.action === "error") {
        return { text: `${parsed.message}\n\n${usage()}` };
      }

      const managementContext = createManagementContext(ctx);

      if (parsed.action === "show") {
        const watch = manager.showWatch(managementContext, parsed.id);
        if (!watch) {
          return { text: `No watch found for ${parsed.id}.` };
        }
        return {
          text: formatWatchDetails(
            watch,
            manager.showWatchEvents(managementContext, parsed.id),
            commandNow(deps),
          ),
        };
      }

      if (parsed.action === "cancel") {
        return {
          text: formatCancelResult(manager.cancelWatch(managementContext, parsed.id), parsed.id),
        };
      }

      let watch: WatchRecord;
      try {
        watch = manager.createParsedWatch(managementContext, parsed);
      } catch (error) {
        return { text: formatManagementError(error) };
      }
      const baselineNote =
        parsed.condition.type === "changed" || parsed.condition.type === "github_pr_state_changed"
          ? "\n- baseline: first check captures the initial snapshot"
          : "";
      return {
        text:
          `Watch ${watch.id} created.\n` +
          `- ${watch.title}\n` +
          `- interval: ${watch.intervalSeconds}s\n` +
          `- next check: ${formatRelativeTime(watch.nextCheckAt, commandNow(deps))}\n` +
          `- expires: ${formatRelativeTime(watch.expiresAt, commandNow(deps))}` +
          baselineNote,
      };
    },
  };
}

function createWatchesCommand(deps: WatchesCommandDeps): OpenClawPluginCommandDefinition {
  const manager = createWatchManagementService(deps);
  return {
    name: "watches",
    description: "List your active temporary watches.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseWatchesCommand(ctx.args);
      const managementContext = createManagementContext(ctx);
      if (parsed.action === "help") {
        return { text: usage() };
      }
      if (parsed.action === "error") {
        return { text: `${parsed.message}\n\n${usage()}` };
      }
      if (parsed.action === "show") {
        const watch = manager.showWatch(managementContext, parsed.id);
        if (!watch) {
          return { text: `No watch found for ${parsed.id}.` };
        }
        return {
          text: formatWatchDetails(
            watch,
            manager.showWatchEvents(managementContext, parsed.id),
            commandNow(deps),
          ),
        };
      }
      if (parsed.action === "cancel") {
        return {
          text: formatCancelResult(manager.cancelWatch(managementContext, parsed.id), parsed.id),
        };
      }
      if (parsed.action === "health") {
        return { text: formatWatchDiagnostics(manager.getDiagnostics(managementContext)) };
      }
      const watches = manager.listWatches(managementContext, {
        includeAll: parsed.includeAll,
        limit: 50,
      });
      if (watches.length === 0) {
        return { text: parsed.includeAll ? "No watches found." : "No active watches." };
      }
      const title = parsed.includeAll ? "Watches" : "Active watches";
      return { text: formatWatchList(title, watches, commandNow(deps)) };
    },
  };
}

export function createWatchesCommands(deps: WatchesCommandDeps): OpenClawPluginCommandDefinition[] {
  return [createWatchCommand(deps), createWatchesCommand(deps)];
}
