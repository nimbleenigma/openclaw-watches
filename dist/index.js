import { definePluginEntry, jsonResult } from "./api.js";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadModelCatalog } from "openclaw/plugin-sdk/agent-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
//#region ../openclaw-watches/src/github-pr.ts
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_REPO_REF_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9]\d*)$/;
function parsePositiveInteger(value) {
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
}
function createGitHubPrSource(params) {
	if (!OWNER_PATTERN.test(params.owner) || !REPO_PATTERN.test(params.repo)) return;
	return {
		owner: params.owner,
		repo: params.repo,
		number: params.number,
		url: `https://github.com/${params.owner}/${params.repo}/pull/${params.number}`,
		query: `${params.owner}/${params.repo}#${params.number}`
	};
}
function parseGitHubPrRef(input) {
	const trimmed = input.trim();
	const shorthand = OWNER_REPO_REF_PATTERN.exec(trimmed);
	if (shorthand) {
		const number = parsePositiveInteger(shorthand[3] ?? "");
		if (!number) return;
		return createGitHubPrSource({
			owner: shorthand[1] ?? "",
			repo: shorthand[2] ?? "",
			number
		});
	}
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return;
	}
	if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return;
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (segments.length < 4 || segments[2] !== "pull") return;
	const number = parsePositiveInteger(segments[3] ?? "");
	if (!number) return;
	return createGitHubPrSource({
		owner: segments[0] ?? "",
		repo: segments[1] ?? "",
		number
	});
}
function requireGitHubPrRef(input) {
	const parsed = parseGitHubPrRef(input);
	if (!parsed) throw new Error("GitHub PR must be a https://github.com/<owner>/<repo>/pull/<number> URL or owner/repo#number.");
	return parsed;
}
function formatGitHubPrRef(source) {
	return `${source.owner}/${source.repo}#${source.number}`;
}
const ALLOWED_REGEX_FLAGS = new Set(["i", "m"]);
function findClosingSlash(value) {
	let escaped = false;
	for (let index = 1; index < value.length; index += 1) {
		const char = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "/") return index;
	}
	return -1;
}
function validateFlags(flags) {
	const seen = /* @__PURE__ */ new Set();
	for (const flag of flags) {
		if (!ALLOWED_REGEX_FLAGS.has(flag)) return "Regex flags can only include i and m.";
		if (seen.has(flag)) return `Regex flag ${flag} is duplicated.`;
		seen.add(flag);
	}
}
function parseWatchRegex(value) {
	const trimmed = value.trim();
	if (!trimmed) return {
		ok: false,
		message: "Regex pattern cannot be empty."
	};
	let pattern = trimmed;
	let flags = "i";
	if (trimmed.startsWith("/")) {
		const closingSlash = findClosingSlash(trimmed);
		if (closingSlash < 0) return {
			ok: false,
			message: "Slash-style regex must end with /flags."
		};
		pattern = trimmed.slice(1, closingSlash);
		flags = trimmed.slice(closingSlash + 1);
		const flagError = validateFlags(flags);
		if (flagError) return {
			ok: false,
			message: flagError
		};
	}
	if (!pattern) return {
		ok: false,
		message: "Regex pattern cannot be empty."
	};
	if (pattern.length > 512) return {
		ok: false,
		message: "Regex pattern is too long."
	};
	try {
		RegExp(pattern, flags);
	} catch (error) {
		return {
			ok: false,
			message: `Regex pattern is invalid: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	return {
		ok: true,
		pattern,
		flags
	};
}
function compileWatchRegex(pattern, flags) {
	const flagError = validateFlags(flags);
	if (flagError) throw new Error(flagError);
	if (!pattern) throw new Error("Regex pattern cannot be empty.");
	if (pattern.length > 512) throw new Error("Regex pattern is too long.");
	return new RegExp(pattern, flags);
}
const DURATION_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)`;
function trimCommandArgs(args) {
	return args?.trim() ?? "";
}
function stripMatchingQuotes(value) {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if (first === `"` && last === `"` || first === `'` && last === `'`) return trimmed.slice(1, -1);
	}
	return trimmed;
}
function splitFirstToken(value) {
	const trimmed = value.trim();
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return {
		token: match?.[1] ?? "",
		rest: match?.[2]?.trim() ?? ""
	};
}
function parseDurationMs(value) {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i.exec(value);
	if (!match) return;
	const amount = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(amount) || amount <= 0) return;
	const unit = (match[2] ?? "").toLowerCase();
	if (unit.startsWith("s")) return Math.round(amount * 1e3);
	if (unit.startsWith("m") && unit !== "month" && unit !== "months") return Math.round(amount * 6e4);
	if (unit.startsWith("h")) return Math.round(amount * 36e5);
	if (unit.startsWith("d")) return Math.round(amount * 864e5);
}
function extractScheduleSuffix(value) {
	let text = value.trim();
	const schedule = {};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (schedule.expiryMs == null) {
			const forMatch = new RegExp(String.raw`\s+for\s+(${DURATION_PATTERN})\s*$`, "i").exec(text);
			if (forMatch) {
				const expiryMs = parseDurationMs(forMatch[1] ?? "");
				if (expiryMs != null) {
					schedule.expiryMs = expiryMs;
					text = text.slice(0, forMatch.index).trim();
					continue;
				}
			}
		}
		if (schedule.intervalSeconds == null) {
			const everyMatch = new RegExp(String.raw`\s+every\s+(${DURATION_PATTERN})\s*$`, "i").exec(text);
			if (everyMatch) {
				const intervalMs = parseDurationMs(everyMatch[1] ?? "");
				if (intervalMs != null) {
					schedule.intervalSeconds = Math.round(intervalMs / 1e3);
					text = text.slice(0, everyMatch.index).trim();
					continue;
				}
			}
		}
	}
	return Object.keys(schedule).length > 0 ? {
		text,
		schedule
	} : { text };
}
function parseUrlContentMode(value) {
	let conditionText = value.trim();
	let contentMode = "raw";
	if (/^text\s+/i.test(conditionText)) {
		conditionText = conditionText.replace(/^text\s+/i, "").trim();
		contentMode = "text";
	}
	if (/\s+text$/i.test(conditionText)) {
		const candidate = conditionText.replace(/\s+text$/i, "").trim();
		if (/^(contains|matches)\s+(["'])([\s\S]*)\2$/i.test(candidate) || /^changed$/i.test(candidate)) {
			conditionText = candidate;
			contentMode = "text";
		}
	}
	return {
		contentMode,
		conditionText
	};
}
function titlePrefixForUrl$1(contentMode) {
	return contentMode === "text" ? "URL text" : "URL";
}
function createUrlSource$1(url, contentMode) {
	return contentMode === "text" ? {
		url,
		contentMode
	} : { url };
}
function parseProviderModel(query) {
	const trimmed = query.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex > 0 && slashIndex < trimmed.length - 1) return {
		query: trimmed,
		provider: trimmed.slice(0, slashIndex).trim(),
		model: trimmed.slice(slashIndex + 1).trim()
	};
	return {
		query: trimmed,
		model: trimmed
	};
}
function parseModelWatch(rest) {
	const scheduled = extractScheduleSuffix(rest);
	const untilMatch = /\s+until\s+available\s*$/i.exec(scheduled.text);
	if (!untilMatch) return {
		action: "error",
		message: "Usage: /watch models <model> until available [every 15m] [for 24h]"
	};
	const query = scheduled.text.slice(0, untilMatch.index).trim();
	if (!query) return {
		action: "error",
		message: "Usage: /watch models <model> until available [every 15m] [for 24h]"
	};
	if (query.length > 128) return {
		action: "error",
		message: "Model watch query is too long."
	};
	return {
		action: "create",
		kind: "model",
		source: parseProviderModel(query),
		condition: { type: "available" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `Model available: ${query}`
	};
}
function parseUrlWatch(rest) {
	const first = splitFirstToken(rest);
	if (!first.token) return {
		action: "error",
		message: "Usage: /watch url <url> contains \"<text>\""
	};
	let parsedUrl;
	try {
		parsedUrl = new URL(first.token);
	} catch {
		return {
			action: "error",
			message: "Watch URL must be a valid http or https URL."
		};
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return {
		action: "error",
		message: "Watch URL must use http or https."
	};
	const scheduled = extractScheduleSuffix(first.rest);
	const { contentMode, conditionText } = parseUrlContentMode(scheduled.text);
	const source = createUrlSource$1(parsedUrl.toString(), contentMode);
	if (/^changed$/i.test(conditionText)) return {
		action: "create",
		kind: "url",
		source,
		condition: { type: "changed" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `${titlePrefixForUrl$1(contentMode)} changed: ${parsedUrl.toString()}`
	};
	const matchesMatch = /^matches\s+([\s\S]+)$/i.exec(conditionText);
	if (matchesMatch) {
		const parsedRegex = parseWatchRegex(stripMatchingQuotes(matchesMatch[1] ?? ""));
		if (!parsedRegex.ok) return {
			action: "error",
			message: parsedRegex.message
		};
		return {
			action: "create",
			kind: "url",
			source,
			condition: {
				type: "matches",
				pattern: parsedRegex.pattern,
				flags: parsedRegex.flags
			},
			...scheduled.schedule ? { schedule: scheduled.schedule } : {},
			title: `${titlePrefixForUrl$1(contentMode)} matches: /${parsedRegex.pattern}/${parsedRegex.flags}`
		};
	}
	const containsMatch = /^contains\s+([\s\S]+)$/i.exec(conditionText);
	if (!containsMatch) return {
		action: "error",
		message: "Usage: /watch url <url> contains \"<text>\""
	};
	const text = stripMatchingQuotes(containsMatch[1] ?? "");
	if (!text) return {
		action: "error",
		message: "Contains watch text cannot be empty."
	};
	if (text.length > 512) return {
		action: "error",
		message: "Contains watch text is too long."
	};
	return {
		action: "create",
		kind: "url",
		source,
		condition: {
			type: "contains",
			text,
			caseSensitive: false
		},
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `${titlePrefixForUrl$1(contentMode)} contains: ${text}`
	};
}
function githubPrUsage() {
	return "Usage: /watch github pr <url|owner/repo#number> until checks pass|fail|merged|approved|changes requested";
}
function parseGitHubWatch(rest) {
	const target = splitFirstToken(rest);
	if (target.token.toLowerCase() !== "pr") return {
		action: "error",
		message: githubPrUsage()
	};
	const ref = splitFirstToken(target.rest);
	if (!ref.token) return {
		action: "error",
		message: githubPrUsage()
	};
	const source = parseGitHubPrRef(ref.token);
	if (!source) return {
		action: "error",
		message: "GitHub PR must be a https://github.com/<owner>/<repo>/pull/<number> URL or owner/repo#number."
	};
	const scheduled = extractScheduleSuffix(ref.rest);
	const conditionText = scheduled.text.trim();
	const label = formatGitHubPrRef(source);
	if (/^until\s+(?:checks|ci)\s+pass(?:es)?$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_checks_pass" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR checks: ${label}`
	};
	if (/^until\s+(?:checks|ci)\s+fail(?:s)?$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_checks_fail" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR checks failing: ${label}`
	};
	if (/^until\s+merged$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_merged" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR merged: ${label}`
	};
	if (/^until\s+(?:review\s+)?approved$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_review_approved" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR approved: ${label}`
	};
	if (/^until\s+(?:review\s+)?changes\s+requested$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_review_changes_requested" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR changes requested: ${label}`
	};
	if (/^changed$/i.test(conditionText)) return {
		action: "create",
		kind: "github_pr",
		source,
		condition: { type: "github_pr_state_changed" },
		...scheduled.schedule ? { schedule: scheduled.schedule } : {},
		title: `PR snapshot: ${label}`
	};
	return {
		action: "error",
		message: githubPrUsage()
	};
}
function parseWatchCommand(args) {
	const trimmed = trimCommandArgs(args);
	if (!trimmed || /^help$/i.test(trimmed)) return { action: "help" };
	const first = splitFirstToken(trimmed);
	const action = first.token.toLowerCase();
	if (action === "cancel") {
		const id = first.rest.trim();
		if (!id) return {
			action: "error",
			message: "Usage: /watch cancel <id>"
		};
		return {
			action: "cancel",
			id
		};
	}
	if (action === "show") {
		const id = first.rest.trim();
		if (!id) return {
			action: "error",
			message: "Usage: /watch show <id>"
		};
		return {
			action: "show",
			id
		};
	}
	if (action === "models" || action === "model") return parseModelWatch(first.rest);
	if (action === "url") return parseUrlWatch(first.rest);
	if (action === "github") return parseGitHubWatch(first.rest);
	return {
		action: "error",
		message: "Usage: /watch models <model> until available"
	};
}
function parseWatchesCommand(args) {
	const trimmed = trimCommandArgs(args);
	if (!trimmed) return {
		action: "list",
		includeAll: false
	};
	if (/^help$/i.test(trimmed)) return { action: "help" };
	if (/^all$/i.test(trimmed)) return {
		action: "list",
		includeAll: true
	};
	const first = splitFirstToken(trimmed);
	const action = first.token.toLowerCase();
	if (action === "show") {
		const id = first.rest.trim();
		return id ? {
			action: "show",
			id
		} : {
			action: "error",
			message: "Usage: /watches show <id>"
		};
	}
	if (action === "cancel") {
		const id = first.rest.trim();
		return id ? {
			action: "cancel",
			id
		} : {
			action: "error",
			message: "Usage: /watches cancel <id>"
		};
	}
	return {
		action: "error",
		message: "Usage: /watches [all|show <id>|cancel <id>]"
	};
}
//#endregion
//#region ../openclaw-watches/src/management.ts
var WatchManagementError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "WatchManagementError";
	}
};
function defaultWatchId() {
	return `w_${randomBytes(4).toString("hex")}`;
}
function nowMs(deps) {
	return deps.now?.() ?? Date.now();
}
function normalizeHttpUrl(input) {
	let parsed;
	try {
		parsed = new URL(input.trim());
	} catch {
		throw new WatchManagementError("Watch URL must be a valid http or https URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WatchManagementError("Watch URL must use http or https.");
	return parsed.toString();
}
function normalizeUrlContentMode(value) {
	if (value == null || value === "" || value === "raw") return "raw";
	if (value === "text") return "text";
	throw new WatchManagementError("URL content mode must be raw or text.");
}
function createUrlSource(url, contentMode) {
	return contentMode === "text" ? {
		url,
		contentMode
	} : { url };
}
function titlePrefixForUrl(contentMode) {
	return contentMode === "text" ? "URL text" : "URL";
}
function normalizeGitHubPr(input) {
	try {
		return requireGitHubPrRef(input);
	} catch (error) {
		throw new WatchManagementError(error instanceof Error ? error.message : String(error));
	}
}
function ensureAccess(watch, context) {
	return context.allowAnyOwner === true || watch.ownerKey === context.ownerKey;
}
function validateIntervalSeconds(value) {
	const intervalSeconds = Math.trunc(value);
	if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400) throw new WatchManagementError("Watch interval must be between 60 seconds and 24 hours.");
	return intervalSeconds;
}
function validateExpiryMs(value) {
	const expiryMs = Math.trunc(value);
	if (!Number.isFinite(expiryMs) || expiryMs < 36e5 || expiryMs > 6048e5) throw new WatchManagementError("Watch expiry must be between 1 hour and 7 days.");
	return expiryMs;
}
var WatchManagementService = class {
	constructor(deps) {
		this.deps = deps;
	}
	createParsedWatch(context, spec) {
		const store = this.deps.getStore();
		const activeCount = store.countActiveForOwner(context.ownerKey);
		if (activeCount >= this.deps.config.maxActivePerOwner) throw new WatchManagementError(`You already have ${activeCount} active watches. Cancel one before adding another.`);
		const now = nowMs(this.deps);
		const intervalSeconds = validateIntervalSeconds(spec.schedule?.intervalSeconds ?? this.deps.config.defaultIntervalSeconds);
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
			createdAt: now
		});
		this.deps.wakeScheduler?.();
		return watch;
	}
	createModelAvailabilityWatch(context, params) {
		const query = params.model.trim();
		if (!query) throw new WatchManagementError("Model watch query cannot be empty.");
		if (query.length > 128) throw new WatchManagementError("Model watch query is too long.");
		return this.createParsedWatch(context, {
			kind: "model",
			source: parseProviderModel(query),
			condition: { type: "available" },
			schedule: params.schedule,
			title: `Model available: ${query}`
		});
	}
	createUrlContainsWatch(context, params) {
		const text = params.text.trim();
		if (!text) throw new WatchManagementError("Contains watch text cannot be empty.");
		if (text.length > 512) throw new WatchManagementError("Contains watch text is too long.");
		const contentMode = normalizeUrlContentMode(params.contentMode);
		const url = normalizeHttpUrl(params.url);
		return this.createParsedWatch(context, {
			kind: "url",
			source: createUrlSource(url, contentMode),
			condition: {
				type: "contains",
				text,
				caseSensitive: false
			},
			schedule: params.schedule,
			title: `${titlePrefixForUrl(contentMode)} contains: ${text}`
		});
	}
	createUrlRegexWatch(context, params) {
		const parsedRegex = parseWatchRegex(params.regex);
		if (!parsedRegex.ok) throw new WatchManagementError(parsedRegex.message);
		const contentMode = normalizeUrlContentMode(params.contentMode);
		return this.createParsedWatch(context, {
			kind: "url",
			source: createUrlSource(normalizeHttpUrl(params.url), contentMode),
			condition: {
				type: "matches",
				pattern: parsedRegex.pattern,
				flags: parsedRegex.flags
			},
			schedule: params.schedule,
			title: `${titlePrefixForUrl(contentMode)} matches: /${parsedRegex.pattern}/${parsedRegex.flags}`
		});
	}
	createUrlChangedWatch(context, params) {
		const url = normalizeHttpUrl(params.url);
		const contentMode = normalizeUrlContentMode(params.contentMode);
		return this.createParsedWatch(context, {
			kind: "url",
			source: createUrlSource(url, contentMode),
			condition: { type: "changed" },
			schedule: params.schedule,
			title: `${titlePrefixForUrl(contentMode)} changed: ${url}`
		});
	}
	createGitHubPrChecksWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_checks_pass" },
			schedule: params.schedule,
			title: `PR checks: ${formatGitHubPrRef(source)}`
		});
	}
	createGitHubPrChecksFailWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_checks_fail" },
			schedule: params.schedule,
			title: `PR checks failing: ${formatGitHubPrRef(source)}`
		});
	}
	createGitHubPrMergedWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_merged" },
			schedule: params.schedule,
			title: `PR merged: ${formatGitHubPrRef(source)}`
		});
	}
	createGitHubPrApprovedWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_review_approved" },
			schedule: params.schedule,
			title: `PR approved: ${formatGitHubPrRef(source)}`
		});
	}
	createGitHubPrChangesRequestedWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_review_changes_requested" },
			schedule: params.schedule,
			title: `PR changes requested: ${formatGitHubPrRef(source)}`
		});
	}
	createGitHubPrStateWatch(context, params) {
		const source = normalizeGitHubPr(params.pr);
		return this.createParsedWatch(context, {
			kind: "github_pr",
			source,
			condition: { type: "github_pr_state_changed" },
			schedule: params.schedule,
			title: `PR snapshot: ${formatGitHubPrRef(source)}`
		});
	}
	listWatches(context, params = {}) {
		return this.deps.getStore().listWatches({
			ownerKey: context.ownerKey,
			includeAll: params.includeAll,
			limit: params.limit
		});
	}
	showWatch(context, id) {
		const watch = this.deps.getStore().getWatch(id);
		return watch && ensureAccess(watch, context) ? watch : void 0;
	}
	showWatchEvents(context, id, params = {}) {
		if (!this.showWatch(context, id)) return [];
		const events = this.deps.getStore().listEvents?.(id) ?? [];
		const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
		return events.slice(-limit);
	}
	cancelWatch(context, id) {
		const cancelled = this.deps.getStore().cancelWatch({
			id,
			ownerKey: context.ownerKey,
			now: nowMs(this.deps),
			allowAnyOwner: context.allowAnyOwner
		});
		if (cancelled?.status === "cancelled") this.deps.wakeScheduler?.();
		return cancelled;
	}
};
function createWatchManagementService(deps) {
	return new WatchManagementService(deps);
}
//#endregion
//#region ../openclaw-watches/src/commands.ts
function resolveWatchOwnerKey(ctx) {
	const sender = ctx.senderId?.trim();
	if (sender) return `${ctx.channel}:${sender}`;
	const from = ctx.from?.trim();
	if (from) return `${ctx.channel}:${from}`;
	const sessionKey = ctx.sessionKey?.trim();
	if (sessionKey) return `session:${sessionKey}`;
	return `channel:${ctx.channel}`;
}
function isAdminContext(ctx) {
	return ctx.gatewayClientScopes?.includes("operator.admin") === true;
}
function captureDeliveryTarget(ctx) {
	return {
		sessionKey: ctx.sessionKey,
		sessionId: ctx.sessionId,
		channel: ctx.channel,
		to: ctx.from ?? ctx.to,
		accountId: ctx.accountId,
		threadId: ctx.messageThreadId,
		senderId: ctx.senderId
	};
}
function createManagementContext(ctx) {
	return {
		ownerKey: resolveWatchOwnerKey(ctx),
		deliveryTarget: captureDeliveryTarget(ctx),
		allowAnyOwner: isAdminContext(ctx)
	};
}
function formatCancelResult(cancelled, id) {
	if (!cancelled) return `No watch found for ${id}.`;
	if (cancelled.status !== "cancelled") return `Watch ${cancelled.id} was not cancelled.\n- final status: ${cancelled.status}\n- ${cancelled.title}`;
	return `Watch ${cancelled.id} cancelled.\n- final status: cancelled\n- ${cancelled.title}`;
}
function formatManagementError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function formatTimestamp(value) {
	return value ? new Date(value).toISOString() : "(none)";
}
function formatDuration(ms) {
	const abs = Math.abs(ms);
	for (const [label, unitMs] of [
		["d", 864e5],
		["h", 36e5],
		["m", 6e4],
		["s", 1e3]
	]) if (abs >= unitMs || label === "s") return `${Math.max(1, Math.round(abs / unitMs))}${label}`;
	return "0s";
}
function formatRelativeTime(value, now = Date.now()) {
	if (!value) return "(none)";
	const delta = value - now;
	const suffix = delta >= 0 ? "from now" : "ago";
	return `${formatTimestamp(value)} (${formatDuration(delta)} ${suffix})`;
}
function compactText(value, maxChars = 120) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function isUrlSource(source) {
	return "url" in source && !("owner" in source);
}
function formatWatchSource(kind, source) {
	if (kind === "url" && isUrlSource(source)) return source.contentMode === "text" ? `${source.url} (page text)` : source.url;
	if (kind === "model" && "query" in source) return source.query;
	if (kind === "github_pr" && "owner" in source) return formatGitHubPrRef(source);
	return "(unknown)";
}
function formatWatchType(kind) {
	switch (kind) {
		case "github_pr": return "GitHub PR";
		case "model": return "model";
		case "url": return "URL";
	}
	return "watch";
}
function formatWatchCondition(condition) {
	switch (condition.type) {
		case "available": return "available";
		case "changed": return "changed";
		case "contains": return `contains "${condition.text}"`;
		case "matches": return `matches /${condition.pattern}/${condition.flags}`;
		case "github_pr_checks_pass": return "checks pass";
		case "github_pr_checks_fail": return "checks fail";
		case "github_pr_merged": return "merged";
		case "github_pr_review_approved": return "approved";
		case "github_pr_review_changes_requested": return "changes requested";
		case "github_pr_state_changed": return "snapshot changed";
	}
	return "(unknown)";
}
function formatStatusPrefix(status) {
	switch (status) {
		case "active": return "active";
		case "cancelled": return "cancelled";
		case "expired": return "expired";
		case "failed": return "failed";
		case "triggered": return "triggered";
	}
	return status;
}
function formatWatchLine(watch) {
	const parts = [
		`- ${watch.id}`,
		formatStatusPrefix(watch.status),
		watch.title
	];
	if (watch.status === "active") {
		parts.push(`next: ${formatRelativeTime(watch.nextCheckAt)}`);
		parts.push(`expires: ${formatRelativeTime(watch.expiresAt)}`);
	}
	parts.push(`last: ${watch.lastResultSummary ? `${compactText(watch.lastResultSummary)} at ${formatTimestamp(watch.lastCheckedAt)}` : "none"}`);
	if (watch.lastError) parts.push(`error: ${compactText(watch.lastError)} (count: ${watch.errorCount})`);
	return parts.join(" | ");
}
function formatTerminalTimestamp(watch) {
	switch (watch.status) {
		case "cancelled": return `- cancelled: ${formatTimestamp(watch.cancelledAt)}`;
		case "expired": return `- expired: ${formatTimestamp(watch.expiredAt)}`;
		case "failed": return "- failed: terminal failure";
		case "triggered": return `- triggered: ${formatTimestamp(watch.triggeredAt)}`;
		case "active": return;
	}
}
function formatWatchEvent(event) {
	const summary = event.summary ? ` | ${compactText(event.summary, 120)}` : "";
	return `- ${formatTimestamp(event.createdAt)} | ${event.eventType}${summary}`;
}
function formatWatchDetails(watch, events = []) {
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
		`- errors: ${watch.errorCount}`
	];
	const terminalTimestamp = formatTerminalTimestamp(watch);
	if (terminalTimestamp) lines.push(terminalTimestamp);
	if (watch.lastError) lines.push(`- last error: ${compactText(watch.lastError, 180)}`);
	if (events.length > 0) lines.push("", "Recent events:", ...events.map(formatWatchEvent));
	return lines.join("\n");
}
function usage() {
	return [
		"Usage:",
		"/watch models <model> until available",
		"/watch url <url> contains \"<text>\"",
		"/watch url <url> changed",
		"/watch url <url> text changed",
		"/watch url <url> matches \"<regex>\"",
		"Optional schedule suffix: every 5m for 6h",
		"Add text for quieter page-text mode, e.g. /watch url <url> text contains \"<text>\"",
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
		"/watches cancel <id>"
	].join("\n");
}
function createWatchCommand(deps) {
	const manager = createWatchManagementService(deps);
	return {
		name: "watch",
		description: "Create or cancel a temporary watch.",
		acceptsArgs: true,
		handler: async (ctx) => {
			const parsed = parseWatchCommand(ctx.args);
			if (parsed.action === "help") return { text: usage() };
			if (parsed.action === "error") return { text: `${parsed.message}\n\n${usage()}` };
			const managementContext = createManagementContext(ctx);
			if (parsed.action === "show") {
				const watch = manager.showWatch(managementContext, parsed.id);
				if (!watch) return { text: `No watch found for ${parsed.id}.` };
				return { text: formatWatchDetails(watch, manager.showWatchEvents(managementContext, parsed.id)) };
			}
			if (parsed.action === "cancel") return { text: formatCancelResult(manager.cancelWatch(managementContext, parsed.id), parsed.id) };
			let watch;
			try {
				watch = manager.createParsedWatch(managementContext, parsed);
			} catch (error) {
				return { text: formatManagementError(error) };
			}
			const baselineNote = parsed.condition.type === "changed" || parsed.condition.type === "github_pr_state_changed" ? "\n- baseline: first check captures the initial snapshot" : "";
			return { text: `Watch ${watch.id} created.\n- ${watch.title}\n- interval: ${watch.intervalSeconds}s\n- next check: ${formatTimestamp(watch.nextCheckAt)}\n- expires: ${formatTimestamp(watch.expiresAt)}` + baselineNote };
		}
	};
}
function createWatchesCommand(deps) {
	const manager = createWatchManagementService(deps);
	return {
		name: "watches",
		description: "List your active temporary watches.",
		acceptsArgs: true,
		handler: async (ctx) => {
			const parsed = parseWatchesCommand(ctx.args);
			const managementContext = createManagementContext(ctx);
			if (parsed.action === "help") return { text: usage() };
			if (parsed.action === "error") return { text: `${parsed.message}\n\n${usage()}` };
			if (parsed.action === "show") {
				const watch = manager.showWatch(managementContext, parsed.id);
				if (!watch) return { text: `No watch found for ${parsed.id}.` };
				return { text: formatWatchDetails(watch, manager.showWatchEvents(managementContext, parsed.id)) };
			}
			if (parsed.action === "cancel") return { text: formatCancelResult(manager.cancelWatch(managementContext, parsed.id), parsed.id) };
			const watches = manager.listWatches(managementContext, {
				includeAll: parsed.includeAll,
				limit: 50
			});
			if (watches.length === 0) return { text: parsed.includeAll ? "No watches found." : "No active watches." };
			return { text: [parsed.includeAll ? "Watches:" : "Active watches:", ...watches.map(formatWatchLine)].join("\n") };
		}
	};
}
function createWatchesCommands(deps) {
	return [createWatchCommand(deps), createWatchesCommand(deps)];
}
//#endregion
//#region ../openclaw-watches/src/config.ts
const DEFAULT_WATCHES_CONFIG = {
	defaultIntervalSeconds: 900,
	defaultExpiryMs: 1440 * 60 * 1e3,
	maxActivePerOwner: 20,
	maxConcurrentChecks: 2,
	claimLeaseMs: 300 * 1e3,
	retentionMs: 10080 * 60 * 1e3,
	urlTimeoutMs: 1e4,
	urlMaxBytes: 512 * 1024,
	githubTokenEnv: "GITHUB_TOKEN",
	maxConsecutiveErrors: 5
};
function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}
function nonEmptyString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveWatchesConfig(input) {
	const defaultIntervalSeconds = finiteNumber(input?.defaultIntervalSeconds) ?? DEFAULT_WATCHES_CONFIG.defaultIntervalSeconds;
	const defaultExpiryHours = finiteNumber(input?.defaultExpiryHours) ?? DEFAULT_WATCHES_CONFIG.defaultExpiryMs / (3600 * 1e3);
	const maxActivePerOwner = finiteNumber(input?.maxActivePerOwner) ?? DEFAULT_WATCHES_CONFIG.maxActivePerOwner;
	return {
		...DEFAULT_WATCHES_CONFIG,
		defaultIntervalSeconds: Math.floor(clamp(defaultIntervalSeconds, 60, 1440 * 60)),
		defaultExpiryMs: Math.floor(clamp(defaultExpiryHours, 1, 168) * 60 * 60 * 1e3),
		githubTokenEnv: nonEmptyString(input?.githubTokenEnv) ?? DEFAULT_WATCHES_CONFIG.githubTokenEnv,
		maxActivePerOwner: Math.floor(clamp(maxActivePerOwner, 1, 100))
	};
}
//#endregion
//#region ../openclaw-watches/src/evaluate.ts
function hashWatchResult(value) {
	return createHash("sha256").update(value).digest("hex");
}
function truncateSummary(value, maxChars = 500) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
function evaluateTextCondition(params) {
	const resultHash = hashWatchResult(params.hashText ?? params.text);
	switch (params.condition.type) {
		case "changed":
			if (!params.previousHash) return {
				triggered: false,
				resultHash,
				summary: "Baseline captured."
			};
			return {
				triggered: params.previousHash !== resultHash,
				resultHash,
				summary: params.previousHash !== resultHash ? "Content changed since the baseline." : "No content change detected."
			};
		case "contains": {
			const haystack = params.condition.caseSensitive ? params.text : params.text.toLowerCase();
			const needle = params.condition.caseSensitive ? params.condition.text : params.condition.text.toLowerCase();
			const matched = haystack.includes(needle);
			return {
				triggered: matched,
				resultHash,
				summary: matched ? `Matched text: ${params.condition.text}` : `Text not found: ${params.condition.text}`
			};
		}
		case "matches": {
			const matched = compileWatchRegex(params.condition.pattern, params.condition.flags).test(params.text);
			const label = `/${params.condition.pattern}/${params.condition.flags}`;
			return {
				triggered: matched,
				resultHash,
				summary: matched ? `Matched regex: ${label}` : `Regex not matched: ${label}`
			};
		}
		case "available": return {
			triggered: false,
			resultHash,
			summary: "Availability conditions are evaluated by model checks."
		};
		case "github_pr_checks_pass":
		case "github_pr_checks_fail":
		case "github_pr_merged":
		case "github_pr_review_approved":
		case "github_pr_review_changes_requested":
		case "github_pr_state_changed": return {
			triggered: false,
			resultHash,
			summary: "GitHub PR conditions are evaluated by GitHub checks."
		};
	}
	return {
		triggered: false,
		resultHash,
		summary: "Unsupported condition."
	};
}
//#endregion
//#region ../openclaw-watches/src/check-github.ts
const GITHUB_HEADERS = {
	accept: "application/vnd.github+json",
	"user-agent": "OpenClaw Watches/1",
	"x-github-api-version": "2022-11-28"
};
var GitHubWatchFetchError = class extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
		this.name = "GitHubWatchFetchError";
	}
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readBoolean(record, key) {
	const value = record[key];
	return typeof value === "boolean" ? value : void 0;
}
function readArray(record, key) {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}
function githubApiUrl(source, path) {
	return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}${path}`;
}
function formatResetTime(value) {
	if (!value) return;
	const seconds = Number.parseInt(value, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return;
	return (/* @__PURE__ */ new Date(seconds * 1e3)).toISOString();
}
function formatGitHubHttpError(response, url) {
	if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
		const resetAt = formatResetTime(response.headers.get("x-ratelimit-reset"));
		return resetAt ? `GitHub API rate limit exceeded; resets at ${resetAt}` : "GitHub API rate limit exceeded";
	}
	return `GitHub API HTTP ${response.status} fetching ${url}`;
}
function githubHeaders(token) {
	const trimmedToken = token?.trim();
	return trimmedToken ? {
		...GITHUB_HEADERS,
		authorization: `Bearer ${trimmedToken}`
	} : GITHUB_HEADERS;
}
async function fetchGitHubJson(params) {
	const fetchFn = params.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
	timeout.unref?.();
	let response;
	try {
		response = await fetchFn(params.url, {
			headers: githubHeaders(params.token),
			signal: controller.signal
		});
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`GitHub API timed out after ${params.timeoutMs}ms`, { cause: error });
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) throw new GitHubWatchFetchError(formatGitHubHttpError(response, params.url), response.status);
	return await response.json();
}
function parsePullResponse(value, source) {
	if (!isRecord(value)) throw new Error("GitHub PR response was not an object");
	const head = value.head;
	if (!isRecord(head)) throw new Error("GitHub PR response did not include head details");
	const headSha = readString(head, "sha");
	if (!headSha) throw new Error("GitHub PR response did not include a head SHA");
	return {
		title: readString(value, "title") ?? formatGitHubPrRef(source),
		htmlUrl: readString(value, "html_url") ?? source.url,
		state: readString(value, "state") ?? "unknown",
		draft: readBoolean(value, "draft") ?? false,
		mergedAt: readString(value, "merged_at"),
		mergeableState: readString(value, "mergeable_state"),
		headSha
	};
}
function parseCombinedStatus(value) {
	if (!isRecord(value)) throw new Error("GitHub combined status response was not an object");
	const statuses = readArray(value, "statuses").filter(isRecord).map((status) => ({
		context: readString(status, "context") ?? "status",
		state: readString(status, "state") ?? "unknown"
	}));
	return {
		state: readString(value, "state") ?? "unknown",
		statuses
	};
}
function parseCheckRuns(value) {
	if (!isRecord(value)) throw new Error("GitHub check-runs response was not an object");
	const checkRuns = readArray(value, "check_runs").filter(isRecord).map((run) => ({
		name: readString(run, "name") ?? "check",
		status: readString(run, "status") ?? "unknown",
		conclusion: readString(run, "conclusion")
	}));
	const totalCountValue = value.total_count;
	return {
		totalCount: typeof totalCountValue === "number" ? totalCountValue : checkRuns.length,
		checkRuns
	};
}
function parseReviews(value) {
	if (!Array.isArray(value)) throw new Error("GitHub reviews response was not an array");
	return value.filter(isRecord).map((review) => {
		const user = review.user;
		return {
			state: (readString(review, "state") ?? "unknown").toUpperCase(),
			user: isRecord(user) ? readString(user, "login") ?? "unknown" : "unknown",
			submittedAt: readString(review, "submitted_at")
		};
	});
}
function isPassingConclusion(value) {
	return value === "success" || value === "neutral" || value === "skipped";
}
function isFailingConclusion(value) {
	return value === "failure" || value === "cancelled" || value === "timed_out" || value === "action_required" || value === "stale" || value === "startup_failure";
}
function rollupChecks(combinedStatus, checkRuns) {
	let failingCount = 0;
	let pendingCount = 0;
	let passingCount = 0;
	if (combinedStatus.state === "failure" || combinedStatus.state === "error") failingCount += 1;
	else if (combinedStatus.state === "pending" && combinedStatus.statuses.length > 0) pendingCount += 1;
	else if (combinedStatus.state === "success" && combinedStatus.statuses.length > 0) passingCount += combinedStatus.statuses.length;
	for (const run of checkRuns.checkRuns) {
		if (run.status !== "completed") {
			pendingCount += 1;
			continue;
		}
		if (isPassingConclusion(run.conclusion)) {
			passingCount += 1;
			continue;
		}
		if (isFailingConclusion(run.conclusion)) {
			failingCount += 1;
			continue;
		}
		pendingCount += 1;
	}
	const signalCount = combinedStatus.statuses.length + checkRuns.checkRuns.length;
	if (failingCount > 0) return {
		state: "failing",
		summary: `failing (${failingCount} failing, ${pendingCount} pending)`,
		statusCount: combinedStatus.statuses.length,
		checkRunCount: checkRuns.totalCount,
		failingCount,
		pendingCount,
		passingCount
	};
	if (pendingCount > 0 || signalCount === 0) return {
		state: "pending",
		summary: signalCount === 0 ? "pending (no checks reported)" : `pending (${pendingCount} pending, ${passingCount} passing)`,
		statusCount: combinedStatus.statuses.length,
		checkRunCount: checkRuns.totalCount,
		failingCount,
		pendingCount: signalCount === 0 ? 1 : pendingCount,
		passingCount
	};
	return {
		state: "passing",
		summary: `passing (${passingCount} passing)`,
		statusCount: combinedStatus.statuses.length,
		checkRunCount: checkRuns.totalCount,
		failingCount,
		pendingCount,
		passingCount
	};
}
function prStateLabel(pr) {
	if (pr.mergedAt) return "merged";
	return pr.draft ? `${pr.state} draft` : pr.state;
}
function checksLabel(checks) {
	if (checks.state === "passing") return `${checks.passingCount} passing`;
	if (checks.state === "failing") {
		const parts = [`${checks.failingCount} failing`];
		if (checks.pendingCount > 0) parts.push(`${checks.pendingCount} pending`);
		return parts.join(", ");
	}
	if (checks.statusCount + checks.checkRunCount === 0) return "pending (no checks reported)";
	const parts = [`${checks.pendingCount} pending`];
	if (checks.passingCount > 0) parts.push(`${checks.passingCount} passing`);
	return parts.join(", ");
}
function rollupReviews(reviews) {
	const latestByUser = /* @__PURE__ */ new Map();
	for (const review of reviews) {
		const previous = latestByUser.get(review.user);
		if (!previous || (review.submittedAt ?? "") >= (previous.submittedAt ?? "")) latestByUser.set(review.user, review);
	}
	const latest = [...reviews].toSorted((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))[0];
	let approvedCount = 0;
	let changesRequestedCount = 0;
	for (const review of latestByUser.values()) {
		if (review.state === "APPROVED") approvedCount += 1;
		if (review.state === "CHANGES_REQUESTED") changesRequestedCount += 1;
	}
	const parts = [];
	if (approvedCount > 0) parts.push(`${approvedCount} approved`);
	if (changesRequestedCount > 0) parts.push(`${changesRequestedCount} changes requested`);
	return {
		approvedCount,
		changesRequestedCount,
		latestState: latest?.state,
		latestUser: latest?.user,
		summary: parts.length > 0 ? parts.join(", ") : "no active review signal"
	};
}
function shortSha(value) {
	return value.slice(0, 7);
}
function snapshotHash(params) {
	return hashWatchResult(JSON.stringify({
		state: params.pr.state,
		draft: params.pr.draft,
		mergedAt: params.pr.mergedAt ?? null,
		mergeableState: params.pr.mergeableState ?? null,
		headSha: params.pr.headSha,
		checksState: params.checks.state,
		failingCount: params.checks.failingCount,
		pendingCount: params.checks.pendingCount,
		passingCount: params.checks.passingCount,
		statusCount: params.checks.statusCount,
		checkRunCount: params.checks.checkRunCount,
		reviewApprovedCount: params.reviews.approvedCount,
		reviewChangesRequestedCount: params.reviews.changesRequestedCount,
		latestReviewState: params.reviews.latestState ?? null,
		latestReviewUser: params.reviews.latestUser ?? null
	}));
}
function formatSnapshotSummary(params) {
	return truncateSummary(`PR snapshot: ${formatGitHubPrRef(params.source)} — ${params.pr.title} | State: ${prStateLabel(params.pr)} | Checks: ${checksLabel(params.checks)} | Reviews: ${params.reviews.summary} | Head: ${shortSha(params.pr.headSha)}`);
}
function snapshotDisplay(snapshot) {
	return {
		ref: formatGitHubPrRef(snapshot.source),
		title: snapshot.title,
		state: snapshot.merged ? "merged" : snapshot.draft ? `${snapshot.state} draft` : snapshot.state,
		checks: checksLabel(snapshot.checks),
		reviews: snapshot.reviews.summary,
		head: shortSha(snapshot.headSha)
	};
}
function parsePreviousSnapshotDisplay(summary) {
	if (!summary) return;
	const state = /\bState:\s*([^|]+)/.exec(summary)?.[1]?.trim();
	const checks = /\bChecks:\s*([^|]+)/.exec(summary)?.[1]?.trim();
	const reviews = /\bReviews:\s*([^|]+)/.exec(summary)?.[1]?.trim();
	const head = /\bHead:\s*([^|]+)/.exec(summary)?.[1]?.trim();
	if (!state && !checks && !reviews && !head) return;
	return {
		state,
		checks,
		reviews,
		head
	};
}
function formatDelta(previous, current) {
	return previous && previous !== current ? `${previous} → ${current}` : current;
}
function formatGitHubPrNotification(params) {
	const current = snapshotDisplay(params.snapshot);
	const previous = parsePreviousSnapshotDisplay(params.previousSummary);
	return [
		params.kind === "checks_passed" ? "✅ PR checks passed" : params.kind === "checks_failed" ? "❌ PR checks failed" : params.kind === "merged" ? "✅ PR merged" : params.kind === "approved" ? "✅ PR approved" : params.kind === "changes_requested" ? "🛠️ PR changes requested" : "👀 PR snapshot changed",
		"",
		`${current.ref} — ${current.title}`,
		`State: ${formatDelta(previous?.state, current.state)}`,
		`Checks: ${formatDelta(previous?.checks, current.checks)}`,
		`Reviews: ${formatDelta(previous?.reviews, current.reviews)}`,
		`Head: ${formatDelta(previous?.head, current.head)}`,
		"",
		params.snapshot.url
	].join("\n");
}
async function fetchGitHubPrSnapshot(params) {
	const pr = parsePullResponse(await fetchGitHubJson({
		url: githubApiUrl(params.source, `/pulls/${params.source.number}`),
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		token: params.token
	}), params.source);
	const combinedStatus = parseCombinedStatus(await fetchGitHubJson({
		url: githubApiUrl(params.source, `/commits/${pr.headSha}/status`),
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		token: params.token
	}));
	const checkRuns = parseCheckRuns(await fetchGitHubJson({
		url: githubApiUrl(params.source, `/commits/${pr.headSha}/check-runs?per_page=100`),
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		token: params.token
	}));
	const reviews = params.includeReviews ? rollupReviews(parseReviews(await fetchGitHubJson({
		url: githubApiUrl(params.source, `/pulls/${params.source.number}/reviews?per_page=100`),
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		token: params.token
	}))) : rollupReviews([]);
	const checks = rollupChecks(combinedStatus, checkRuns);
	const summary = formatSnapshotSummary({
		source: params.source,
		pr,
		checks,
		reviews
	});
	return {
		source: params.source,
		title: pr.title,
		url: pr.htmlUrl,
		state: pr.state,
		draft: pr.draft,
		merged: Boolean(pr.mergedAt),
		mergedAt: pr.mergedAt,
		mergeableState: pr.mergeableState,
		headSha: pr.headSha,
		checks,
		reviews,
		summary,
		resultHash: snapshotHash({
			pr,
			checks,
			reviews
		})
	};
}
async function checkGitHubPrWatch(params) {
	if (params.watch.kind !== "github_pr") throw new Error(`Expected GitHub PR watch, got ${params.watch.kind}`);
	const source = params.watch.source;
	const includeReviews = params.watch.condition.type === "github_pr_review_approved" || params.watch.condition.type === "github_pr_review_changes_requested" || params.watch.condition.type === "github_pr_state_changed";
	const snapshot = await fetchGitHubPrSnapshot({
		source,
		timeoutMs: params.timeoutMs,
		fetchImpl: params.fetchImpl,
		includeReviews,
		token: params.token
	});
	if (params.watch.condition.type === "github_pr_checks_pass") {
		if (snapshot.checks.state !== "passing") return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			notification: formatGitHubPrNotification({
				kind: "checks_passed",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	if (params.watch.condition.type === "github_pr_checks_fail") {
		if (snapshot.checks.state !== "failing") return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			notification: formatGitHubPrNotification({
				kind: "checks_failed",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	if (params.watch.condition.type === "github_pr_merged") {
		if (!snapshot.merged) return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			notification: formatGitHubPrNotification({
				kind: "merged",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	if (params.watch.condition.type === "github_pr_review_approved") {
		if (snapshot.reviews.approvedCount === 0) return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			notification: formatGitHubPrNotification({
				kind: "approved",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	if (params.watch.condition.type === "github_pr_review_changes_requested") {
		if (snapshot.reviews.changesRequestedCount === 0) return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: snapshot.summary,
			notification: formatGitHubPrNotification({
				kind: "changes_requested",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	if (params.watch.condition.type === "github_pr_state_changed") {
		if (!params.watch.lastResultHash) return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: `Baseline captured: ${snapshot.summary}`,
			payload: snapshot
		};
		if (params.watch.lastResultHash === snapshot.resultHash) return {
			triggered: false,
			resultHash: snapshot.resultHash,
			summary: `No PR snapshot change: ${snapshot.summary}`,
			payload: snapshot
		};
		return {
			triggered: true,
			resultHash: snapshot.resultHash,
			summary: `PR snapshot changed: ${snapshot.summary}`,
			notification: formatGitHubPrNotification({
				kind: "snapshot_changed",
				snapshot,
				previousSummary: params.watch.lastResultSummary
			}),
			payload: snapshot
		};
	}
	throw new Error(`Unsupported GitHub PR watch condition: ${params.watch.condition.type}`);
}
//#endregion
//#region ../openclaw-watches/src/check-model.ts
function normalize(value) {
	return value?.trim().toLowerCase() ?? "";
}
function splitProviderModel(query) {
	const trimmed = query.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex > 0 && slashIndex < trimmed.length - 1) return {
		provider: trimmed.slice(0, slashIndex).trim(),
		model: trimmed.slice(slashIndex + 1).trim()
	};
	return { model: trimmed };
}
function entryMatchesQuery(entry, source) {
	const parsed = splitProviderModel(source.query);
	const expectedProvider = normalize(source.provider ?? parsed.provider);
	if (expectedProvider && normalize(entry.provider) !== expectedProvider) return false;
	const expectedModel = normalize(source.model ?? parsed.model ?? source.query);
	if (!expectedModel) return false;
	return [
		entry.id,
		entry.name,
		entry.alias
	].map(normalize).filter(Boolean).some((candidate) => candidate === expectedModel || candidate.includes(expectedModel));
}
function findAvailableModel(catalog, source) {
	return catalog.find((entry) => entryMatchesQuery(entry, source));
}
async function checkModelAvailability(params) {
	if (params.watch.kind !== "model") throw new Error(`Expected model watch, got ${params.watch.kind}`);
	const source = params.watch.source;
	const catalog = await (params.loadCatalog ?? loadModelCatalog)({
		config: params.cfg,
		useCache: false
	});
	const resultHash = hashWatchResult(catalog.map((entry) => `${entry.provider}/${entry.id}`).toSorted().join("\n"));
	const match = findAvailableModel(catalog, source);
	if (!match) return {
		triggered: false,
		resultHash,
		summary: `No available model matched ${source.query}.`
	};
	const modelLabel = `${match.provider}/${match.id}`;
	return {
		triggered: true,
		resultHash,
		summary: `Matched ${modelLabel}.`,
		notification: `Watch triggered: ${params.watch.title}\n\nAvailable model: ${modelLabel}`,
		payload: {
			provider: match.provider,
			id: match.id,
			name: match.name
		}
	};
}
//#endregion
//#region ../openclaw-watches/src/check-url.ts
const TEXTUAL_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/xhtml+xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/javascript"
];
var UrlWatchFetchError = class extends Error {
	constructor(message, status, finalUrl, options) {
		super(message, options);
		this.status = status;
		this.finalUrl = finalUrl;
		this.name = "UrlWatchFetchError";
	}
};
function assertHttpUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL watches only support http and https URLs");
}
function isTextualContentType(contentType) {
	if (!contentType) return true;
	const lower = contentType.toLowerCase();
	return TEXTUAL_CONTENT_TYPES.some((prefix) => lower.startsWith(prefix));
}
function displayContentType(contentType) {
	return contentType?.split(";")[0]?.trim().toLowerCase() || "unknown content type";
}
function formatFetchDetails(metadata) {
	const mode = metadata.contentMode === "text" ? " · page text" : "";
	return `HTTP ${metadata.status} · ${displayContentType(metadata.contentType)}${mode}`;
}
function decodeHtmlEntities(text) {
	return text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&apos;/gi, "'").replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&ndash;/gi, "-").replace(/&mdash;/gi, "--").replace(/&hellip;/gi, "...").replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
		const codePoint = Number.parseInt(hex, 16);
		return Number.isFinite(codePoint) && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : "";
	}).replace(/&#(\d+);/g, (_match, decimal) => {
		const codePoint = Number.parseInt(decimal, 10);
		return Number.isFinite(codePoint) && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : "";
	});
}
function normalizeVisibleText(text) {
	return normalizeStableVisibleText(decodeHtmlEntities(text));
}
function isLikelyVolatileLine(line) {
	return /^(?:last\s+)?(?:generated|built|updated|modified|refreshed)\s+(?:at|on)?:?\s+\d/i.test(line) || /^(?:build|asset|chunk|commit|revision|etag|nonce|trace|request)\s*(?:id|hash)?:?\s+[a-z0-9._:-]{8,}$/i.test(line) || /^\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?$/i.test(line) || /^[a-f0-9]{32,64}$/i.test(line);
}
function normalizeStableVisibleText(text) {
	return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line && !isLikelyVolatileLine(line)).join("\n").replace(/\s+/g, " ").trim();
}
function isHtmlContentType(contentType) {
	const lower = contentType?.toLowerCase() ?? "";
	return lower.startsWith("text/html") || lower.startsWith("application/xhtml+xml") || lower.includes("+html");
}
function stripHtmlToVisibleText(html) {
	let scoped = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ").replace(/<template\b[\s\S]*?<\/template>/gi, " ").replace(/<(nav|header|footer|aside|form|dialog|svg|canvas)\b[\s\S]*?<\/\1>/gi, " ");
	const articleOrMain = [...scoped.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2] ?? "").toSorted((a, b) => b.length - a.length)[0];
	if (articleOrMain) scoped = articleOrMain;
	else {
		const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(scoped)?.[1];
		if (body) scoped = body;
	}
	return normalizeVisibleText(scoped.replace(/<(br|hr)\b[^>]*>/gi, "\n").replace(/<\/(p|div|section|article|main|header|footer|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, " "));
}
function prepareUrlWatchText(params) {
	if (params.contentMode !== "text") return params.text;
	if (isHtmlContentType(params.contentType)) return stripHtmlToVisibleText(params.text);
	return normalizeVisibleText(params.text);
}
function describeHttpFailure(status, finalUrl) {
	if (status === 401) return `This site requires authentication or blocked the basic fetch with HTTP 401. Basic URL watches use safe unauthenticated HTTP fetches; try a public URL.`;
	if (status === 403) return `This site blocked the basic fetch with HTTP 403. Basic URL watches use safe unauthenticated HTTP fetches; try a simpler/public URL or wait for browser-rendered watches.`;
	if (status === 429) return `This site rate-limited the basic fetch with HTTP 429. Basic URL watches use conservative polling, but the site may require waiting or a simpler/public URL.`;
	return `HTTP ${status} fetching ${finalUrl}`;
}
function formatGuardedFetchError(error, timeoutMs) {
	const message = error instanceof Error ? error.message : String(error);
	if (/abort|timeout|timed out/i.test(message) || error instanceof Error && error.name === "AbortError") return `URL fetch timed out after ${timeoutMs}ms. Basic URL watches use bounded safe HTTP fetches; try a faster or smaller page.`;
	if (/too many redirects|redirect loop|redirect missing location/i.test(message)) return `URL redirect could not be followed safely: ${message}. Basic URL watches follow only a small number of safe redirects.`;
	if (/blocked|private|internal|special-use|ssrf/i.test(message)) return `URL target was blocked by network safety checks. Basic URL watches can only fetch public HTTP/HTTPS URLs.`;
	return `URL fetch failed: ${message}`;
}
async function readResponseTextWithLimit(response, maxBytes, finalUrl) {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsed = Number.parseInt(contentLength, 10);
		if (Number.isFinite(parsed) && parsed > maxBytes) throw new UrlWatchFetchError(`URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`, response.status, finalUrl);
	}
	const contentType = response.headers.get("content-type");
	if (!isTextualContentType(contentType)) throw new UrlWatchFetchError(`URL response is not text-like content (${displayContentType(contentType ?? void 0)}). URL watches can only evaluate text, HTML, JSON, or XML responses.`, response.status, finalUrl);
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) throw new UrlWatchFetchError(`URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`, response.status, finalUrl);
		return new TextDecoder().decode(buffer);
	}
	const chunks = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new UrlWatchFetchError(`URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`, response.status, finalUrl);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(out);
}
async function fetchUrlText(params) {
	assertHttpUrl(params.url);
	const contentMode = params.contentMode ?? "raw";
	let guarded;
	try {
		guarded = await fetchWithSsrFGuard({
			url: params.url,
			init: {
				method: "GET",
				headers: {
					accept: "text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.1",
					"user-agent": "OpenClaw Watches/1"
				}
			},
			timeoutMs: params.timeoutMs,
			maxRedirects: 3,
			fetchImpl: params.fetchImpl,
			auditContext: "watches-url"
		});
	} catch (error) {
		if (error instanceof UrlWatchFetchError) throw error;
		throw new UrlWatchFetchError(formatGuardedFetchError(error, params.timeoutMs), void 0, params.url, { cause: error });
	}
	const { response, finalUrl, release } = guarded;
	try {
		if (!response.ok) throw new UrlWatchFetchError(describeHttpFailure(response.status, finalUrl), response.status, finalUrl);
		const contentType = response.headers.get("content-type") ?? void 0;
		const rawText = await readResponseTextWithLimit(response, params.maxBytes, finalUrl);
		return {
			finalUrl,
			status: response.status,
			text: prepareUrlWatchText({
				text: rawText,
				contentType,
				contentMode
			}),
			contentType,
			contentMode
		};
	} finally {
		await release();
	}
}
function quoteForSummary(value) {
	return `"${truncateSummary(value, 80)}"`;
}
function formatUrlConditionSummary(params) {
	const details = formatFetchDetails(params.metadata);
	switch (params.condition.type) {
		case "contains": return params.evaluatedSummary.startsWith("Matched") ? `Matched: ${quoteForSummary(params.condition.text)} · ${details}` : `Text not found: ${quoteForSummary(params.condition.text)} · ${details}`;
		case "matches": return params.evaluatedSummary.startsWith("Matched") ? `Matched regex: /${params.condition.pattern}/${params.condition.flags} · ${details}` : `Regex not matched: /${params.condition.pattern}/${params.condition.flags} · ${details}`;
		case "changed":
			if (params.evaluatedSummary.startsWith("Baseline")) return `Baseline captured · ${details}`;
			return params.evaluatedSummary.startsWith("Content changed") ? `Content changed since baseline · ${details}` : `No content change detected · ${details}`;
		default: return `${params.evaluatedSummary} · ${details}`;
	}
}
function formatUrlNotification(params) {
	const details = formatFetchDetails(params.fetched);
	const context = [params.watch.lastResultSummary ? `Previous: ${truncateSummary(params.watch.lastResultSummary, 180)}` : void 0, `Current: ${truncateSummary(params.fetched.text, 260)}`].filter(Boolean);
	if (params.condition.type === "changed") return [
		"👀 URL changed",
		"",
		params.fetched.finalUrl,
		params.summary,
		details,
		...context
	].join("\n");
	if (params.condition.type === "matches") return [
		"🔎 URL regex matched",
		"",
		params.fetched.finalUrl,
		`Matched regex: /${params.condition.pattern}/${params.condition.flags}`,
		details,
		...context
	].join("\n");
	if (params.condition.type === "contains") return [
		"🔎 URL text found",
		"",
		params.fetched.finalUrl,
		`Matched: ${quoteForSummary(params.condition.text)}`,
		details,
		...context
	].join("\n");
	return [
		`Watch triggered: ${params.watch.title}`,
		"",
		params.summary,
		...context
	].join("\n");
}
async function checkUrlWatch(params) {
	if (params.watch.kind !== "url") throw new Error(`Expected URL watch, got ${params.watch.kind}`);
	const source = params.watch.source;
	const condition = params.watch.condition;
	const fetched = await fetchUrlText({
		url: source.url,
		timeoutMs: params.timeoutMs,
		maxBytes: params.maxBytes,
		contentMode: source.contentMode,
		fetchImpl: params.fetchImpl
	});
	const canonical = `${fetched.status}\n${fetched.finalUrl}\n${fetched.text}`;
	const evaluated = evaluateTextCondition({
		condition,
		text: condition.type === "changed" ? canonical : fetched.text,
		hashText: canonical,
		previousHash: params.watch.lastResultHash
	});
	const summary = truncateSummary(formatUrlConditionSummary({
		condition,
		evaluatedSummary: evaluated.summary,
		metadata: fetched
	}));
	if (!evaluated.triggered) return {
		triggered: false,
		resultHash: evaluated.resultHash,
		summary,
		payload: {
			status: fetched.status,
			finalUrl: fetched.finalUrl,
			contentType: fetched.contentType,
			contentMode: fetched.contentMode
		}
	};
	return {
		triggered: true,
		resultHash: evaluated.resultHash,
		summary,
		notification: formatUrlNotification({
			watch: params.watch,
			condition,
			summary,
			fetched
		}),
		payload: {
			status: fetched.status,
			finalUrl: fetched.finalUrl,
			contentType: fetched.contentType,
			contentMode: fetched.contentMode
		}
	};
}
//#endregion
//#region ../openclaw-watches/src/scheduler.ts
function formatError$1(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}
function backoffMs(errorCount) {
	return Math.min(3600 * 1e3, 6e4 * 2 ** Math.max(0, Math.min(errorCount, 8)));
}
function nextIntervalAt(now, watch) {
	return now + Math.max(60, watch.intervalSeconds) * 1e3;
}
function notificationTargetFromWatch(watch) {
	return {
		sessionKey: watch.ownerSessionKey,
		channel: watch.ownerChannel,
		to: watch.ownerTo,
		accountId: watch.ownerAccountId,
		threadId: watch.ownerThreadId
	};
}
function readGithubToken(config) {
	const tokenEnv = config.githubTokenEnv.trim();
	return tokenEnv ? process.env[tokenEnv]?.trim() || void 0 : void 0;
}
async function defaultEvaluator(watch, context, config) {
	if (watch.kind === "model") return await checkModelAvailability({
		watch,
		cfg: context.cfg
	});
	if (watch.kind === "url") return await checkUrlWatch({
		watch,
		timeoutMs: config.urlTimeoutMs,
		maxBytes: config.urlMaxBytes
	});
	if (watch.kind === "github_pr") return await checkGitHubPrWatch({
		watch,
		timeoutMs: config.urlTimeoutMs,
		token: readGithubToken(config)
	});
	throw new Error(`Unsupported watch kind: ${watch.kind ?? "unknown"}`);
}
var WatchesScheduler = class {
	constructor(options) {
		this.options = options;
		this.timer = null;
		this.running = false;
		this.stopped = true;
		this.now = options.now ?? Date.now;
		this.claimedBy = options.claimedBy ?? `watches:${process.pid}`;
	}
	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.tickAndReschedule();
	}
	stop() {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
	async tickOnce() {
		const wasStopped = this.stopped;
		this.stopped = false;
		try {
			await this.tick();
		} finally {
			this.stopped = wasStopped;
		}
	}
	wake() {
		if (this.stopped) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.tickAndReschedule();
	}
	scheduleNext() {
		if (this.stopped) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const now = this.now();
		const nextDueAt = this.options.store.getNextDueAt(now);
		const delay = nextDueAt == null ? 6e4 : Math.min(6e4, Math.max(0, nextDueAt - now));
		this.timer = setTimeout(() => {
			this.timer = null;
			this.tickAndReschedule();
		}, delay);
		this.timer.unref?.();
	}
	async tickAndReschedule() {
		try {
			await this.tick();
		} finally {
			this.scheduleNext();
		}
	}
	async tick() {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			const now = this.now();
			this.options.store.expireDueWatches(now);
			this.options.store.cleanupTerminal(now - this.options.config.retentionMs);
			const due = this.options.store.claimDueWatches({
				now,
				limit: this.options.config.maxConcurrentChecks,
				claimedBy: this.claimedBy,
				leaseMs: this.options.config.claimLeaseMs
			});
			await Promise.all(due.map((watch) => this.processWatch(watch)));
		} finally {
			this.running = false;
		}
	}
	async evaluate(watch) {
		if (this.options.evaluator) return await this.options.evaluator(watch, { cfg: this.options.cfg });
		return await defaultEvaluator(watch, { cfg: this.options.cfg }, this.options.config);
	}
	async processWatch(watch) {
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
					payload: outcome.payload
				});
				return;
			}
			const notification = await this.options.runtime.system.notifyCapturedTarget({
				text: outcome.notification,
				target: notificationTargetFromWatch(watch),
				cfg: this.options.cfg,
				idempotencyKey: `watch:${watch.id}:trigger:${outcome.resultHash}`,
				reason: "watch-triggered"
			});
			if (!notification.delivered) throw new Error(`notification not delivered: ${notification.error}`);
			this.options.store.triggerWatch({
				id: watch.id,
				claimedBy: this.claimedBy,
				now,
				resultHash: outcome.resultHash,
				summary: outcome.summary,
				payload: outcome.payload
			});
		} catch (error) {
			const now = this.now();
			const message = formatError$1(error);
			const nextErrorCount = watch.errorCount + 1;
			const terminal = nextErrorCount >= this.options.config.maxConsecutiveErrors;
			this.options.store.failWatchCheck({
				id: watch.id,
				claimedBy: this.claimedBy,
				now,
				nextCheckAt: terminal ? null : now + backoffMs(nextErrorCount),
				error: message,
				terminal
			});
			if (terminal) await this.options.runtime.system.notifyCapturedTarget({
				text: `Watch failed: ${watch.title}\n\n${message}`,
				target: notificationTargetFromWatch(watch),
				cfg: this.options.cfg,
				idempotencyKey: `watch:${watch.id}:failed`,
				reason: "watch-failed"
			});
			this.options.logger?.warn(`watch check failed (${watch.id}): ${message}`);
		}
	}
};
//#endregion
//#region ../openclaw-watches/src/store.sqlite.ts
const require = createRequire(import.meta.url);
const WATCHES_DIR_MODE = 448;
const WATCHES_FILE_MODE = 384;
const WATCHES_SIDECAR_SUFFIXES = [
	"",
	"-shm",
	"-wal"
];
function requireNodeSqlite() {
	try {
		return require("node:sqlite");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`SQLite support is unavailable in this Node runtime. ${message}`, { cause: error });
	}
}
function normalizeNumber(value) {
	if (typeof value === "bigint") return Number(value);
	return typeof value === "number" ? value : void 0;
}
function serializeJson(value) {
	return JSON.stringify(value);
}
function parseJson(value) {
	return JSON.parse(value);
}
function parseJsonOptional(value) {
	if (!value) return;
	try {
		return JSON.parse(value);
	} catch {
		return;
	}
}
function ensureParentDir(dbPath) {
	const dir = path.dirname(dbPath);
	fs.mkdirSync(dir, {
		recursive: true,
		mode: WATCHES_DIR_MODE
	});
	try {
		fs.chmodSync(dir, WATCHES_DIR_MODE);
	} catch {}
}
function chmodSqliteFiles(dbPath) {
	for (const suffix of WATCHES_SIDECAR_SUFFIXES) {
		const filePath = `${dbPath}${suffix}`;
		if (!fs.existsSync(filePath)) continue;
		try {
			fs.chmodSync(filePath, WATCHES_FILE_MODE);
		} catch {}
	}
}
function hasColumn(db, table, column) {
	return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
function ensureColumn(db, table, column, definition) {
	if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function openDatabase(dbPath) {
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
function rowToWatch(row) {
	return {
		id: row.id,
		ownerKey: row.owner_key,
		ownerSessionKey: row.owner_session_key ?? void 0,
		ownerSessionId: row.owner_session_id ?? void 0,
		ownerChannel: row.owner_channel ?? void 0,
		ownerTo: row.owner_to ?? void 0,
		ownerAccountId: row.owner_account_id ?? void 0,
		ownerThreadId: row.owner_thread_id ?? void 0,
		ownerSenderId: row.owner_sender_id ?? void 0,
		title: row.title,
		kind: row.kind,
		source: parseJson(row.source_json),
		condition: parseJson(row.condition_json),
		status: row.status,
		intervalSeconds: normalizeNumber(row.interval_seconds) ?? 0,
		nextCheckAt: normalizeNumber(row.next_check_at),
		expiresAt: normalizeNumber(row.expires_at) ?? 0,
		lastCheckedAt: normalizeNumber(row.last_checked_at),
		lastResultHash: row.last_result_hash ?? void 0,
		lastResultSummary: row.last_result_summary ?? void 0,
		lastNotifiedHash: row.last_notified_hash ?? void 0,
		cooldownUntil: normalizeNumber(row.cooldown_until),
		errorCount: normalizeNumber(row.error_count) ?? 0,
		lastError: row.last_error ?? void 0,
		claimedUntil: normalizeNumber(row.claimed_until),
		claimedBy: row.claimed_by ?? void 0,
		createdAt: normalizeNumber(row.created_at) ?? 0,
		updatedAt: normalizeNumber(row.updated_at) ?? 0,
		triggeredAt: normalizeNumber(row.triggered_at),
		expiredAt: normalizeNumber(row.expired_at),
		cancelledAt: normalizeNumber(row.cancelled_at)
	};
}
function rowToEvent(row) {
	return {
		id: row.id,
		watchId: row.watch_id,
		eventType: row.event_type,
		resultHash: row.result_hash ?? void 0,
		summary: row.summary ?? void 0,
		payload: parseJsonOptional(row.payload_json),
		createdAt: normalizeNumber(row.created_at) ?? 0
	};
}
function bindCreateWatch(input) {
	return {
		id: input.id,
		owner_key: input.ownerKey,
		owner_session_key: input.deliveryTarget.sessionKey ?? null,
		owner_session_id: input.deliveryTarget.sessionId ?? null,
		owner_channel: input.deliveryTarget.channel ?? null,
		owner_to: input.deliveryTarget.to ?? null,
		owner_account_id: input.deliveryTarget.accountId ?? null,
		owner_thread_id: input.deliveryTarget.threadId != null ? String(input.deliveryTarget.threadId) : null,
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
		updated_at: input.createdAt
	};
}
function resolveWatchesSqlitePath(stateDir) {
	return path.join(stateDir, "watches", "watches.sqlite");
}
var WatchesStore = class {
	constructor(dbPath) {
		this.dbPath = dbPath;
		this.db = openDatabase(dbPath);
	}
	close() {
		this.db.close();
	}
	transaction(run) {
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
	insertEvent(params) {
		this.db.prepare(`INSERT INTO watch_events (
          id, watch_id, event_type, result_hash, summary, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), params.watchId, params.eventType, params.resultHash ?? null, params.summary ?? null, params.payload == null ? null : serializeJson(params.payload), params.now);
	}
	createWatch(input) {
		return this.transaction(() => {
			this.db.prepare(`INSERT INTO watches (
            id, owner_key, owner_session_key, owner_session_id, owner_channel, owner_to,
            owner_account_id, owner_thread_id, owner_sender_id, title, kind, source_json,
            condition_json, status, interval_seconds, next_check_at, expires_at, error_count,
            created_at, updated_at
          ) VALUES (
            @id, @owner_key, @owner_session_key, @owner_session_id, @owner_channel, @owner_to,
            @owner_account_id, @owner_thread_id, @owner_sender_id, @title, @kind, @source_json,
            @condition_json, @status, @interval_seconds, @next_check_at, @expires_at,
            @error_count, @created_at, @updated_at
          )`).run(bindCreateWatch(input));
			this.insertEvent({
				watchId: input.id,
				eventType: "created",
				summary: input.title,
				now: input.createdAt
			});
			const created = this.getWatch(input.id);
			if (!created) throw new Error("Created watch could not be read back");
			return created;
		});
	}
	getWatch(id) {
		const row = this.db.prepare(`SELECT * FROM watches WHERE id = ?`).get(id);
		return row ? rowToWatch(row) : void 0;
	}
	listWatches(params = {}) {
		const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
		return this.db.prepare(`SELECT * FROM watches
         WHERE (@owner_key IS NULL OR owner_key = @owner_key)
           AND (@include_all = 1 OR status = 'active')
         ORDER BY created_at DESC, id ASC
         LIMIT @limit`).all({
			owner_key: params.ownerKey ?? null,
			include_all: params.includeAll ? 1 : 0,
			limit
		}).map(rowToWatch);
	}
	countActiveForOwner(ownerKey) {
		return normalizeNumber(this.db.prepare(`SELECT COUNT(*) AS count FROM watches WHERE owner_key = ? AND status = 'active'`).get(ownerKey)?.count ?? null) ?? 0;
	}
	cancelWatch(params) {
		return this.transaction(() => {
			const row = this.db.prepare(`SELECT * FROM watches
           WHERE id = @id
             AND (@allow_any_owner = 1 OR owner_key = @owner_key)`).get({
				id: params.id,
				owner_key: params.ownerKey ?? "",
				allow_any_owner: params.allowAnyOwner ? 1 : 0
			});
			if (!row) return;
			if (row.status === "active") {
				this.db.prepare(`UPDATE watches
             SET status = 'cancelled',
                 cancelled_at = @now,
                 next_check_at = NULL,
                 claimed_until = NULL,
                 claimed_by = NULL,
                 updated_at = @now
             WHERE id = @id`).run({
					id: params.id,
					now: params.now
				});
				this.insertEvent({
					watchId: params.id,
					eventType: "cancelled",
					summary: "Watch cancelled.",
					now: params.now
				});
			}
			return this.getWatch(params.id);
		});
	}
	expireDueWatches(now) {
		return this.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM watches WHERE status = 'active' AND expires_at <= ?`).all(now);
			for (const row of rows) {
				this.db.prepare(`UPDATE watches
             SET status = 'expired',
                 expired_at = @now,
                 next_check_at = NULL,
                 claimed_until = NULL,
                 claimed_by = NULL,
                 updated_at = @now
             WHERE id = @id`).run({
					id: row.id,
					now
				});
				this.insertEvent({
					watchId: row.id,
					eventType: "expired",
					summary: "Watch expired.",
					now
				});
			}
			return rows.map(rowToWatch);
		});
	}
	claimDueWatches(params) {
		return this.transaction(() => {
			const rows = this.db.prepare(`SELECT * FROM watches
           WHERE status = 'active'
             AND next_check_at IS NOT NULL
             AND next_check_at <= @now
             AND expires_at > @now
             AND (cooldown_until IS NULL OR cooldown_until <= @now)
             AND (claimed_until IS NULL OR claimed_until <= @now)
           ORDER BY next_check_at ASC, id ASC
           LIMIT @limit`).all({
				now: params.now,
				limit: Math.max(1, params.limit)
			});
			const claimed = [];
			for (const row of rows) if (this.db.prepare(`UPDATE watches
             SET claimed_until = @claimed_until,
                 claimed_by = @claimed_by,
                 updated_at = @now
             WHERE id = @id
               AND status = 'active'
               AND (claimed_until IS NULL OR claimed_until <= @now)`).run({
				id: row.id,
				now: params.now,
				claimed_until: params.now + params.leaseMs,
				claimed_by: params.claimedBy
			}).changes > 0) {
				const next = this.getWatch(row.id);
				if (next) claimed.push(next);
			}
			return claimed;
		});
	}
	completeWatchCheck(params) {
		this.transaction(() => {
			this.db.prepare(`UPDATE watches
           SET last_checked_at = @now,
               last_result_hash = @result_hash,
               last_result_summary = @summary,
               error_count = 0,
               last_error = NULL,
               next_check_at = @next_check_at,
               claimed_until = NULL,
               claimed_by = NULL,
               updated_at = @now
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`).run({
				id: params.id,
				claimed_by: params.claimedBy,
				now: params.now,
				next_check_at: params.nextCheckAt,
				result_hash: params.resultHash,
				summary: params.summary
			});
			this.insertEvent({
				watchId: params.id,
				eventType: "checked",
				resultHash: params.resultHash,
				summary: params.summary,
				payload: params.payload,
				now: params.now
			});
		});
	}
	triggerWatch(params) {
		this.transaction(() => {
			this.db.prepare(`UPDATE watches
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
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`).run({
				id: params.id,
				claimed_by: params.claimedBy,
				now: params.now,
				result_hash: params.resultHash,
				summary: params.summary
			});
			this.insertEvent({
				watchId: params.id,
				eventType: "triggered",
				resultHash: params.resultHash,
				summary: params.summary,
				payload: params.payload,
				now: params.now
			});
		});
	}
	failWatchCheck(params) {
		this.transaction(() => {
			this.db.prepare(`UPDATE watches
           SET status = CASE WHEN @terminal = 1 THEN 'failed' ELSE status END,
               last_checked_at = @now,
               last_error = @error,
               error_count = error_count + 1,
               next_check_at = @next_check_at,
               claimed_until = NULL,
               claimed_by = NULL,
               updated_at = @now
           WHERE id = @id AND claimed_by = @claimed_by AND status = 'active'`).run({
				id: params.id,
				claimed_by: params.claimedBy,
				now: params.now,
				error: params.error,
				next_check_at: params.nextCheckAt,
				terminal: params.terminal ? 1 : 0
			});
			this.insertEvent({
				watchId: params.id,
				eventType: "failed",
				summary: params.error,
				now: params.now
			});
		});
	}
	getNextDueAt(now) {
		return normalizeNumber(this.db.prepare(`SELECT MIN(next_check_at) AS next_due
         FROM watches
         WHERE status = 'active'
           AND next_check_at IS NOT NULL
           AND expires_at > @now
           AND (cooldown_until IS NULL OR cooldown_until <= @now)
           AND (claimed_until IS NULL OR claimed_until <= @now)`).get({ now })?.next_due ?? null);
	}
	listEvents(watchId) {
		return this.db.prepare(`SELECT * FROM watch_events WHERE watch_id = ? ORDER BY created_at ASC, id ASC`).all(watchId).map(rowToEvent);
	}
	cleanupTerminal(before) {
		const result = this.db.prepare(`DELETE FROM watches
         WHERE status IN ('triggered', 'expired', 'cancelled', 'failed')
           AND updated_at < ?`).run(before);
		return Number(result.changes ?? 0);
	}
};
//#endregion
//#region ../openclaw-watches/src/tool.ts
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
			"list",
			"show",
			"cancel"
		],
		description: "Watch management action."
	}),
	model: Type.Optional(Type.String({ description: "Model or provider/model query." })),
	pr: Type.Optional(Type.String({ description: "GitHub PR URL or owner/repo#number for create_github_pr_* actions." })),
	url: Type.Optional(Type.String({ description: "HTTP or HTTPS URL to watch." })),
	text: Type.Optional(Type.String({ description: "Text for create_url_contains." })),
	regex: Type.Optional(Type.String({ description: "Regex pattern for create_url_matches." })),
	content_mode: Type.Optional(Type.String({
		enum: ["raw", "text"],
		description: "Optional URL content mode. Use text for readable page text extraction."
	})),
	interval_seconds: Type.Optional(Type.Number({
		minimum: 60,
		maximum: 86400,
		description: "Optional per-watch polling interval in seconds."
	})),
	expires_in_seconds: Type.Optional(Type.Number({
		minimum: 3600,
		maximum: 604800,
		description: "Optional per-watch lifetime in seconds."
	})),
	watch_id: Type.Optional(Type.String({ description: "Watch id for show or cancel." })),
	include_all: Type.Optional(Type.Boolean({ description: "List terminal watches as well as active watches." })),
	limit: Type.Optional(Type.Number({ description: "Maximum watches to return." }))
});
function readTrimmedString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function requireString(params, key) {
	const value = readTrimmedString(params[key]);
	if (!value) throw new Error(`${key} required`);
	return value;
}
function readLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return 50;
	return Math.min(100, Math.max(1, Math.trunc(value)));
}
function readUrlContentMode(value) {
	if (value == null) return;
	if (value === "raw" || value === "text") return value;
	throw new Error("content_mode must be raw or text");
}
function readSchedule(params) {
	const schedule = {};
	if (params.interval_seconds != null) {
		if (typeof params.interval_seconds !== "number" || !Number.isFinite(params.interval_seconds)) throw new Error("interval_seconds must be a number");
		schedule.intervalSeconds = Math.trunc(params.interval_seconds);
	}
	if (params.expires_in_seconds != null) {
		if (typeof params.expires_in_seconds !== "number" || !Number.isFinite(params.expires_in_seconds)) throw new Error("expires_in_seconds must be a number");
		schedule.expiryMs = Math.trunc(params.expires_in_seconds * 1e3);
	}
	return Object.keys(schedule).length > 0 ? schedule : void 0;
}
function serializeWatch(watch) {
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
		createdAt: watch.createdAt,
		updatedAt: watch.updatedAt,
		triggeredAt: watch.triggeredAt,
		expiredAt: watch.expiredAt,
		cancelledAt: watch.cancelledAt
	};
}
function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}
function createWatchManagementContextForTool(ctx) {
	const delivery = ctx.deliveryContext;
	const channel = readTrimmedString(delivery?.channel) ?? readTrimmedString(ctx.messageChannel);
	const to = readTrimmedString(delivery?.to);
	const sessionKey = readTrimmedString(ctx.sessionKey);
	const sessionId = readTrimmedString(ctx.sessionId);
	const senderId = readTrimmedString(ctx.requesterSenderId);
	const accountId = readTrimmedString(delivery?.accountId) ?? readTrimmedString(ctx.agentAccountId);
	const agentId = readTrimmedString(ctx.agentId);
	let ownerKey;
	if (channel && senderId) ownerKey = `${channel}:${senderId}`;
	else if (sessionKey) ownerKey = `session:${sessionKey}`;
	else if (channel && to) ownerKey = `${channel}:${to}`;
	else if (sessionId) ownerKey = `session-id:${sessionId}`;
	else if (agentId) ownerKey = `agent:${agentId}`;
	else ownerKey = "tool:unknown";
	return {
		ownerKey,
		deliveryTarget: {
			sessionKey,
			sessionId,
			channel,
			to,
			accountId,
			threadId: delivery?.threadId,
			senderId
		}
	};
}
function createWatchesManagementTool(params) {
	const context = createWatchManagementContextForTool(params.ctx);
	return {
		name: "watches_manage",
		label: "Watches",
		description: "Create, list, show, and cancel temporary watches scoped to the active requester/session. Supports model availability, URL content/regex/change checks, and GitHub PR checks, merge, review, and snapshot watches.",
		parameters: WatchManagementToolSchema,
		async execute(_toolCallId, rawParams) {
			const raw = rawParams && typeof rawParams === "object" ? rawParams : {};
			const action = raw.action;
			try {
				switch (action) {
					case "create_model_availability": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createModelAvailabilityWatch(context, {
							model: requireString(raw, "model"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_url_contains": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createUrlContainsWatch(context, {
							url: requireString(raw, "url"),
							text: requireString(raw, "text"),
							contentMode: readUrlContentMode(raw.content_mode),
							schedule: readSchedule(raw)
						}))
					});
					case "create_url_matches": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createUrlRegexWatch(context, {
							url: requireString(raw, "url"),
							regex: requireString(raw, "regex"),
							contentMode: readUrlContentMode(raw.content_mode),
							schedule: readSchedule(raw)
						}))
					});
					case "create_url_changed": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createUrlChangedWatch(context, {
							url: requireString(raw, "url"),
							contentMode: readUrlContentMode(raw.content_mode),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_checks": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrChecksWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_checks_failed": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrChecksFailWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_merged": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrMergedWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_approved": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrApprovedWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_changes_requested": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrChangesRequestedWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "create_github_pr_state": return jsonResult({
						ok: true,
						action,
						watch: serializeWatch(params.manager.createGitHubPrStateWatch(context, {
							pr: requireString(raw, "pr"),
							schedule: readSchedule(raw)
						}))
					});
					case "list": return jsonResult({
						ok: true,
						action,
						watches: params.manager.listWatches(context, {
							includeAll: raw.include_all === true,
							limit: readLimit(raw.limit)
						}).map(serializeWatch)
					});
					case "show": {
						const watchId = requireString(raw, "watch_id");
						const watch = params.manager.showWatch(context, watchId);
						return jsonResult(watch ? {
							ok: true,
							action,
							watch: serializeWatch(watch)
						} : {
							ok: false,
							action,
							error: `No watch found for ${watchId}.`
						});
					}
					case "cancel": {
						const watchId = requireString(raw, "watch_id");
						const watch = params.manager.cancelWatch(context, watchId);
						return jsonResult(watch ? {
							ok: true,
							action,
							watch: serializeWatch(watch),
							finalStatus: watch.status
						} : {
							ok: false,
							action,
							error: `No watch found for ${watchId}.`
						});
					}
					default: throw new Error("action required");
				}
			} catch (error) {
				return jsonResult({
					ok: false,
					action: action ?? null,
					error: formatError(error)
				});
			}
		}
	};
}
//#endregion
//#region ../openclaw-watches/index.ts
var openclaw_watches_default = definePluginEntry({
	id: "watches",
	name: "Watches",
	description: "Temporary model, URL, and GitHub PR watches that notify the originating chat.",
	register(api) {
		const config = resolveWatchesConfig(api.pluginConfig);
		let store = null;
		let storePath = null;
		let scheduler = null;
		function getStore(stateDir = api.runtime.state.resolveStateDir()) {
			const nextPath = resolveWatchesSqlitePath(stateDir);
			if (store && storePath === nextPath) return store;
			store?.close();
			store = new WatchesStore(nextPath);
			storePath = nextPath;
			return store;
		}
		api.registerService({
			id: "watches-scheduler",
			start: async (ctx) => {
				scheduler?.stop();
				scheduler = new WatchesScheduler({
					store: getStore(ctx.stateDir),
					runtime: api.runtime,
					cfg: ctx.config,
					config,
					logger: ctx.logger
				});
				scheduler.start();
			},
			stop: async () => {
				scheduler?.stop();
				scheduler = null;
				store?.close();
				store = null;
				storePath = null;
			}
		});
		const managementDeps = {
			getStore: () => getStore(),
			config,
			wakeScheduler: () => scheduler?.wake()
		};
		const manager = createWatchManagementService(managementDeps);
		for (const command of createWatchesCommands({
			api,
			...managementDeps
		})) api.registerCommand(command);
		api.registerTool((ctx) => createWatchesManagementTool({
			manager,
			ctx
		}), { name: "watches_manage" });
	}
});
//#endregion
export { openclaw_watches_default as default };
