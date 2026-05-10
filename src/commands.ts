import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "../api.js";
import { formatGitHubPrRef } from "./github-pr.js";
import {
  createWatchManagementService,
  type WatchManagementDeps,
  type WatchManagementContext,
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
  const delta = value - now;
  const suffix = delta >= 0 ? "from now" : "ago";
  return `${formatTimestamp(value)} (${formatDuration(delta)} ${suffix})`;
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

function formatWatchLine(watch: WatchRecord): string {
  const parts = [`- ${watch.id}`, formatStatusPrefix(watch.status), watch.title];
  if (watch.status === "active") {
    parts.push(`next: ${formatRelativeTime(watch.nextCheckAt)}`);
    parts.push(`expires: ${formatRelativeTime(watch.expiresAt)}`);
  }
  parts.push(
    `last: ${
      watch.lastResultSummary
        ? `${compactText(watch.lastResultSummary)} at ${formatTimestamp(watch.lastCheckedAt)}`
        : "none"
    }`,
  );
  if (watch.lastError) {
    parts.push(`error: ${compactText(watch.lastError)} (count: ${watch.errorCount})`);
  }
  return parts.join(" | ");
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
}

function formatWatchEvent(event: WatchEventRecord): string {
  const summary = event.summary ? ` | ${compactText(event.summary, 120)}` : "";
  return `- ${formatTimestamp(event.createdAt)} | ${event.eventType}${summary}`;
}

function formatWatchDetails(watch: WatchRecord, events: WatchEventRecord[] = []): string {
  const lines = [
    `Watch ${watch.id}`,
    `- status: ${watch.status}`,
    `- title: ${watch.title}`,
    `- type: ${formatWatchType(watch.kind)}`,
    `- source: ${formatWatchSource(watch.kind, watch.source)}`,
    `- condition: ${formatWatchCondition(watch.condition)}`,
    `- interval: ${watch.intervalSeconds}s`,
    `- next check: ${formatRelativeTime(watch.nextCheckAt)}`,
    `- expires: ${formatRelativeTime(watch.expiresAt)}`,
    `- created: ${formatTimestamp(watch.createdAt)}`,
    `- updated: ${formatTimestamp(watch.updatedAt)}`,
    `- last check: ${formatTimestamp(watch.lastCheckedAt)}`,
    `- last result: ${watch.lastResultSummary ? compactText(watch.lastResultSummary, 180) : "none"}`,
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
    "/watches show <id>",
    "/watches cancel <id>",
  ].join("\n");
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
          text: formatWatchDetails(watch, manager.showWatchEvents(managementContext, parsed.id)),
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
          `- next check: ${formatTimestamp(watch.nextCheckAt)}\n` +
          `- expires: ${formatTimestamp(watch.expiresAt)}` +
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
          text: formatWatchDetails(watch, manager.showWatchEvents(managementContext, parsed.id)),
        };
      }
      if (parsed.action === "cancel") {
        return {
          text: formatCancelResult(manager.cancelWatch(managementContext, parsed.id), parsed.id),
        };
      }
      const watches = manager.listWatches(managementContext, {
        includeAll: parsed.includeAll,
        limit: 50,
      });
      if (watches.length === 0) {
        return { text: parsed.includeAll ? "No watches found." : "No active watches." };
      }
      const title = parsed.includeAll ? "Watches:" : "Active watches:";
      return { text: [title, ...watches.map(formatWatchLine)].join("\n") };
    },
  };
}

export function createWatchesCommands(deps: WatchesCommandDeps): OpenClawPluginCommandDefinition[] {
  return [createWatchCommand(deps), createWatchesCommand(deps)];
}
