import { randomBytes } from "node:crypto";
import type { WatchesConfig } from "./config.js";
import { formatGitHubPrRef, requireGitHubPrRef } from "./github-pr.js";
import { MAX_CONDITION_TEXT_CHARS, MAX_MODEL_QUERY_CHARS, parseProviderModel } from "./parse.js";
import { parseWatchRegex } from "./regex.js";
import type {
  CreateWatchInput,
  WatchCondition,
  WatchDeliveryTarget,
  WatchEventRecord,
  WatchKind,
  WatchRecord,
  WatchScheduleSpec,
  WatchSource,
  UrlWatchSource,
} from "./types.js";

type UrlContentMode = NonNullable<UrlWatchSource["contentMode"]>;

export type WatchManagementStore = {
  createWatch(input: CreateWatchInput): WatchRecord;
  countActiveForOwner(ownerKey: string): number;
  listWatches(params?: { ownerKey?: string; includeAll?: boolean; limit?: number }): WatchRecord[];
  getWatch(id: string): WatchRecord | undefined;
  listEvents?(watchId: string): WatchEventRecord[];
  cancelWatch(params: {
    id: string;
    ownerKey?: string;
    now: number;
    allowAnyOwner?: boolean;
  }): WatchRecord | undefined;
};

export type WatchManagementContext = {
  ownerKey: string;
  deliveryTarget: WatchDeliveryTarget;
  allowAnyOwner?: boolean;
};

export type WatchCreateSpec = {
  kind: WatchKind;
  source: WatchSource;
  condition: WatchCondition;
  schedule?: WatchScheduleSpec;
  title: string;
};

export type WatchManagementDeps = {
  getStore: () => WatchManagementStore;
  config: WatchesConfig;
  now?: () => number;
  idGenerator?: () => string;
  wakeScheduler?: () => void;
};

export class WatchManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchManagementError";
  }
}

function defaultWatchId(): string {
  return `w_${randomBytes(4).toString("hex")}`;
}

function nowMs(deps: WatchManagementDeps): number {
  return deps.now?.() ?? Date.now();
}

function normalizeHttpUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new WatchManagementError("Watch URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WatchManagementError("Watch URL must use http or https.");
  }
  return parsed.toString();
}

function normalizeUrlContentMode(value?: string): UrlContentMode {
  if (value == null || value === "" || value === "raw") {
    return "raw";
  }
  if (value === "text") {
    return "text";
  }
  throw new WatchManagementError("URL content mode must be raw or text.");
}

function createUrlSource(url: string, contentMode: UrlContentMode): UrlWatchSource {
  return contentMode === "text" ? { url, contentMode } : { url };
}

function titlePrefixForUrl(contentMode: UrlContentMode): string {
  return contentMode === "text" ? "URL text" : "URL";
}

function normalizeGitHubPr(input: string) {
  try {
    return requireGitHubPrRef(input);
  } catch (error) {
    throw new WatchManagementError(error instanceof Error ? error.message : String(error));
  }
}

function ensureAccess(watch: WatchRecord, context: WatchManagementContext): boolean {
  return context.allowAnyOwner === true || watch.ownerKey === context.ownerKey;
}

function validateIntervalSeconds(value: number): number {
  const intervalSeconds = Math.trunc(value);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86_400) {
    throw new WatchManagementError("Watch interval must be between 60 seconds and 24 hours.");
  }
  return intervalSeconds;
}

function validateExpiryMs(value: number): number {
  const expiryMs = Math.trunc(value);
  if (!Number.isFinite(expiryMs) || expiryMs < 3_600_000 || expiryMs > 604_800_000) {
    throw new WatchManagementError("Watch expiry must be between 1 hour and 7 days.");
  }
  return expiryMs;
}

export class WatchManagementService {
  constructor(private readonly deps: WatchManagementDeps) {}

  createParsedWatch(context: WatchManagementContext, spec: WatchCreateSpec): WatchRecord {
    const store = this.deps.getStore();
    const activeCount = store.countActiveForOwner(context.ownerKey);
    if (activeCount >= this.deps.config.maxActivePerOwner) {
      throw new WatchManagementError(
        `You already have ${activeCount} active watches. Cancel one before adding another.`,
      );
    }

    const now = nowMs(this.deps);
    const intervalSeconds = validateIntervalSeconds(
      spec.schedule?.intervalSeconds ?? this.deps.config.defaultIntervalSeconds,
    );
    const expiryMs = validateExpiryMs(spec.schedule?.expiryMs ?? this.deps.config.defaultExpiryMs);
    const watch = store.createWatch({
      id: (this.deps.idGenerator ?? defaultWatchId)(),
      ownerKey: context.ownerKey,
      deliveryTarget: context.deliveryTarget,
      title: spec.title,
      kind: spec.kind,
      source: spec.source,
      condition: spec.condition,
      intervalSeconds,
      nextCheckAt: now,
      expiresAt: now + expiryMs,
      createdAt: now,
    });
    this.deps.wakeScheduler?.();
    return watch;
  }

  createModelAvailabilityWatch(
    context: WatchManagementContext,
    params: { model: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const query = params.model.trim();
    if (!query) {
      throw new WatchManagementError("Model watch query cannot be empty.");
    }
    if (query.length > MAX_MODEL_QUERY_CHARS) {
      throw new WatchManagementError("Model watch query is too long.");
    }
    return this.createParsedWatch(context, {
      kind: "model",
      source: parseProviderModel(query),
      condition: { type: "available" },
      schedule: params.schedule,
      title: `Model available: ${query}`,
    });
  }

  createUrlContainsWatch(
    context: WatchManagementContext,
    params: {
      url: string;
      text: string;
      contentMode?: UrlContentMode;
      schedule?: WatchScheduleSpec;
    },
  ): WatchRecord {
    const text = params.text.trim();
    if (!text) {
      throw new WatchManagementError("Contains watch text cannot be empty.");
    }
    if (text.length > MAX_CONDITION_TEXT_CHARS) {
      throw new WatchManagementError("Contains watch text is too long.");
    }
    const contentMode = normalizeUrlContentMode(params.contentMode);
    const url = normalizeHttpUrl(params.url);
    return this.createParsedWatch(context, {
      kind: "url",
      source: createUrlSource(url, contentMode),
      condition: { type: "contains", text, caseSensitive: false },
      schedule: params.schedule,
      title: `${titlePrefixForUrl(contentMode)} contains: ${text}`,
    });
  }

  createUrlRegexWatch(
    context: WatchManagementContext,
    params: {
      url: string;
      regex: string;
      contentMode?: UrlContentMode;
      schedule?: WatchScheduleSpec;
    },
  ): WatchRecord {
    const parsedRegex = parseWatchRegex(params.regex);
    if (!parsedRegex.ok) {
      throw new WatchManagementError(parsedRegex.message);
    }
    const contentMode = normalizeUrlContentMode(params.contentMode);
    return this.createParsedWatch(context, {
      kind: "url",
      source: createUrlSource(normalizeHttpUrl(params.url), contentMode),
      condition: { type: "matches", pattern: parsedRegex.pattern, flags: parsedRegex.flags },
      schedule: params.schedule,
      title: `${titlePrefixForUrl(contentMode)} matches: /${parsedRegex.pattern}/${
        parsedRegex.flags
      }`,
    });
  }

  createUrlChangedWatch(
    context: WatchManagementContext,
    params: { url: string; contentMode?: UrlContentMode; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const url = normalizeHttpUrl(params.url);
    const contentMode = normalizeUrlContentMode(params.contentMode);
    return this.createParsedWatch(context, {
      kind: "url",
      source: createUrlSource(url, contentMode),
      condition: { type: "changed" },
      schedule: params.schedule,
      title: `${titlePrefixForUrl(contentMode)} changed: ${url}`,
    });
  }

  createGitHubPrChecksWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_checks_pass" },
      schedule: params.schedule,
      title: `PR checks: ${formatGitHubPrRef(source)}`,
    });
  }

  createGitHubPrChecksFailWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_checks_fail" },
      schedule: params.schedule,
      title: `PR checks failing: ${formatGitHubPrRef(source)}`,
    });
  }

  createGitHubPrMergedWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_merged" },
      schedule: params.schedule,
      title: `PR merged: ${formatGitHubPrRef(source)}`,
    });
  }

  createGitHubPrApprovedWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_review_approved" },
      schedule: params.schedule,
      title: `PR approved: ${formatGitHubPrRef(source)}`,
    });
  }

  createGitHubPrChangesRequestedWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_review_changes_requested" },
      schedule: params.schedule,
      title: `PR changes requested: ${formatGitHubPrRef(source)}`,
    });
  }

  createGitHubPrStateWatch(
    context: WatchManagementContext,
    params: { pr: string; schedule?: WatchScheduleSpec },
  ): WatchRecord {
    const source = normalizeGitHubPr(params.pr);
    return this.createParsedWatch(context, {
      kind: "github_pr",
      source,
      condition: { type: "github_pr_state_changed" },
      schedule: params.schedule,
      title: `PR snapshot: ${formatGitHubPrRef(source)}`,
    });
  }

  listWatches(
    context: WatchManagementContext,
    params: { includeAll?: boolean; limit?: number } = {},
  ): WatchRecord[] {
    return this.deps.getStore().listWatches({
      ownerKey: context.ownerKey,
      includeAll: params.includeAll,
      limit: params.limit,
    });
  }

  showWatch(context: WatchManagementContext, id: string): WatchRecord | undefined {
    const watch = this.deps.getStore().getWatch(id);
    return watch && ensureAccess(watch, context) ? watch : undefined;
  }

  showWatchEvents(
    context: WatchManagementContext,
    id: string,
    params: { limit?: number } = {},
  ): WatchEventRecord[] {
    const watch = this.showWatch(context, id);
    if (!watch) {
      return [];
    }
    const events = this.deps.getStore().listEvents?.(id) ?? [];
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    return events.slice(-limit);
  }

  cancelWatch(context: WatchManagementContext, id: string): WatchRecord | undefined {
    const cancelled = this.deps.getStore().cancelWatch({
      id,
      ownerKey: context.ownerKey,
      now: nowMs(this.deps),
      allowAnyOwner: context.allowAnyOwner,
    });
    if (cancelled?.status === "cancelled") {
      this.deps.wakeScheduler?.();
    }
    return cancelled;
  }
}

export function createWatchManagementService(deps: WatchManagementDeps): WatchManagementService {
  return new WatchManagementService(deps);
}
