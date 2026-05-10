import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { evaluateTextCondition, truncateSummary } from "./evaluate.js";
import type { CheckOutcome, UrlWatchSource, WatchRecord } from "./types.js";

const TEXTUAL_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
];

export class UrlWatchFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly finalUrl?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UrlWatchFetchError";
  }
}

type FetchUrlTextParams = {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  contentMode?: UrlContentMode;
  fetchImpl?: typeof fetch;
};

type UrlContentMode = NonNullable<UrlWatchSource["contentMode"]>;

type UrlFetchResult = {
  finalUrl: string;
  status: number;
  text: string;
  contentType?: string;
  contentMode: UrlContentMode;
};

type UrlContentInput = {
  text: string;
  contentType?: string;
  contentMode: UrlContentMode;
};

type UrlFetchMetadata = {
  status: number;
  finalUrl: string;
  contentType?: string;
  contentMode: UrlContentMode;
};

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL watches only support http and https URLs");
  }
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  const lower = contentType.toLowerCase();
  return TEXTUAL_CONTENT_TYPES.some((prefix) => lower.startsWith(prefix));
}

function displayContentType(contentType?: string): string {
  const trimmed = contentType?.split(";")[0]?.trim().toLowerCase();
  return trimmed || "unknown content type";
}

function formatFetchDetails(metadata: UrlFetchMetadata): string {
  const mode = metadata.contentMode === "text" ? " · page text" : "";
  return `HTTP ${metadata.status} · ${displayContentType(metadata.contentType)}${mode}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "--")
    .replace(/&hellip;/gi, "...")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function normalizeVisibleText(text: string): string {
  return normalizeStableVisibleText(decodeHtmlEntities(text));
}

function isLikelyVolatileLine(line: string): boolean {
  return (
    /^(?:last\s+)?(?:generated|built|updated|modified|refreshed)\s+(?:at|on)?:?\s+\d/i.test(
      line,
    ) ||
    /^(?:build|asset|chunk|commit|revision|etag|nonce|trace|request)\s*(?:id|hash)?:?\s+[a-z0-9._:-]{8,}$/i.test(
      line,
    ) ||
    /^\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?$/i.test(
      line,
    ) ||
    /^[a-f0-9]{32,64}$/i.test(line)
  );
}

function normalizeStableVisibleText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !isLikelyVolatileLine(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function isHtmlContentType(contentType?: string): boolean {
  const lower = contentType?.toLowerCase() ?? "";
  return (
    lower.startsWith("text/html") ||
    lower.startsWith("application/xhtml+xml") ||
    lower.includes("+html")
  );
}

function stripHtmlToVisibleText(html: string): string {
  let scoped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(
      /<(nav|header|footer|aside|form|dialog|svg|canvas)\b[\s\S]*?<\/\1>/gi,
      " ",
    );
  const articleOrMain = [...scoped.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2] ?? "")
    .toSorted((a, b) => b.length - a.length)[0];
  if (articleOrMain) {
    scoped = articleOrMain;
  } else {
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(scoped)?.[1];
    if (body) {
      scoped = body;
    }
  }
  const text = scoped
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeVisibleText(text);
}

export function prepareUrlWatchText(params: UrlContentInput): string {
  if (params.contentMode !== "text") {
    return params.text;
  }
  if (isHtmlContentType(params.contentType)) {
    return stripHtmlToVisibleText(params.text);
  }
  return normalizeVisibleText(params.text);
}

function describeHttpFailure(status: number, finalUrl: string): string {
  if (status === 401) {
    return `This site requires authentication or blocked the basic fetch with HTTP 401. Basic URL watches use safe unauthenticated HTTP fetches; try a public URL.`;
  }
  if (status === 403) {
    return `This site blocked the basic fetch with HTTP 403. Basic URL watches use safe unauthenticated HTTP fetches; try a simpler/public URL or wait for browser-rendered watches.`;
  }
  if (status === 429) {
    return `This site rate-limited the basic fetch with HTTP 429. Basic URL watches use conservative polling, but the site may require waiting or a simpler/public URL.`;
  }
  return `HTTP ${status} fetching ${finalUrl}`;
}

function formatGuardedFetchError(error: unknown, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /abort|timeout|timed out/i.test(message) ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return `URL fetch timed out after ${timeoutMs}ms. Basic URL watches use bounded safe HTTP fetches; try a faster or smaller page.`;
  }
  if (/too many redirects|redirect loop|redirect missing location/i.test(message)) {
    return `URL redirect could not be followed safely: ${message}. Basic URL watches follow only a small number of safe redirects.`;
  }
  if (/blocked|private|internal|special-use|ssrf/i.test(message)) {
    return `URL target was blocked by network safety checks. Basic URL watches can only fetch public HTTP/HTTPS URLs.`;
  }
  return `URL fetch failed: ${message}`;
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  finalUrl: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new UrlWatchFetchError(
        `URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`,
        response.status,
        finalUrl,
      );
    }
  }
  const contentType = response.headers.get("content-type");
  if (!isTextualContentType(contentType)) {
    throw new UrlWatchFetchError(
      `URL response is not text-like content (${displayContentType(
        contentType ?? undefined,
      )}). URL watches can only evaluate text, HTML, JSON, or XML responses.`,
      response.status,
      finalUrl,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new UrlWatchFetchError(
        `URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`,
        response.status,
        finalUrl,
      );
    }
    return new TextDecoder().decode(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UrlWatchFetchError(
        `URL response exceeds ${maxBytes} bytes. URL watches only inspect bounded responses; try a smaller page or text endpoint.`,
        response.status,
        finalUrl,
      );
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

export async function fetchUrlText(params: FetchUrlTextParams): Promise<UrlFetchResult> {
  assertHttpUrl(params.url);
  const contentMode = params.contentMode ?? "raw";
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: {
        method: "GET",
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          "user-agent": "OpenClaw Watches/1",
        },
      },
      timeoutMs: params.timeoutMs,
      maxRedirects: 3,
      fetchImpl: params.fetchImpl,
      auditContext: "watches-url",
    });
  } catch (error) {
    if (error instanceof UrlWatchFetchError) {
      throw error;
    }
    throw new UrlWatchFetchError(
      formatGuardedFetchError(error, params.timeoutMs),
      undefined,
      params.url,
      { cause: error },
    );
  }
  const { response, finalUrl, release } = guarded;
  try {
    if (!response.ok) {
      throw new UrlWatchFetchError(
        describeHttpFailure(response.status, finalUrl),
        response.status,
        finalUrl,
      );
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    const rawText = await readResponseTextWithLimit(response, params.maxBytes, finalUrl);
    return {
      finalUrl,
      status: response.status,
      text: prepareUrlWatchText({ text: rawText, contentType, contentMode }),
      contentType,
      contentMode,
    };
  } finally {
    await release();
  }
}

function quoteForSummary(value: string): string {
  return `"${truncateSummary(value, 80)}"`;
}

function formatUrlConditionSummary(params: {
  condition: WatchRecord["condition"];
  evaluatedSummary: string;
  metadata: UrlFetchMetadata;
}): string {
  const details = formatFetchDetails(params.metadata);
  switch (params.condition.type) {
    case "contains":
      return params.evaluatedSummary.startsWith("Matched")
        ? `Matched: ${quoteForSummary(params.condition.text)} · ${details}`
        : `Text not found: ${quoteForSummary(params.condition.text)} · ${details}`;
    case "matches":
      return params.evaluatedSummary.startsWith("Matched")
        ? `Matched regex: /${params.condition.pattern}/${params.condition.flags} · ${details}`
        : `Regex not matched: /${params.condition.pattern}/${params.condition.flags} · ${details}`;
    case "changed":
      if (params.evaluatedSummary.startsWith("Baseline")) {
        return `Baseline captured · ${details}`;
      }
      return params.evaluatedSummary.startsWith("Content changed")
        ? `Content changed since baseline · ${details}`
        : `No content change detected · ${details}`;
    default:
      return `${params.evaluatedSummary} · ${details}`;
  }
}

function formatUrlNotification(params: {
  watch: WatchRecord;
  condition: WatchRecord["condition"];
  summary: string;
  fetched: UrlFetchResult;
}): string {
  const details = formatFetchDetails(params.fetched);
  const previous = params.watch.lastResultSummary
    ? `Previous: ${truncateSummary(params.watch.lastResultSummary, 180)}`
    : undefined;
  const current = `Current: ${truncateSummary(params.fetched.text, 260)}`;
  const context = [previous, current].filter(Boolean) as string[];
  if (params.condition.type === "changed") {
    return [
      "👀 URL changed",
      "",
      params.fetched.finalUrl,
      params.summary,
      details,
      ...context,
    ].join("\n");
  }
  if (params.condition.type === "matches") {
    return [
      "🔎 URL regex matched",
      "",
      params.fetched.finalUrl,
      `Matched regex: /${params.condition.pattern}/${params.condition.flags}`,
      details,
      ...context,
    ].join("\n");
  }
  if (params.condition.type === "contains") {
    return [
      "🔎 URL text found",
      "",
      params.fetched.finalUrl,
      `Matched: ${quoteForSummary(params.condition.text)}`,
      details,
      ...context,
    ].join("\n");
  }
  return [`Watch triggered: ${params.watch.title}`, "", params.summary, ...context].join("\n");
}

export async function checkUrlWatch(params: {
  watch: WatchRecord;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<CheckOutcome> {
  if (params.watch.kind !== "url") {
    throw new Error(`Expected URL watch, got ${params.watch.kind}`);
  }
  const source = params.watch.source as UrlWatchSource;
  const condition = params.watch.condition;
  const fetched = await fetchUrlText({
    url: source.url,
    timeoutMs: params.timeoutMs,
    maxBytes: params.maxBytes,
    contentMode: source.contentMode,
    fetchImpl: params.fetchImpl,
  });
  const canonical = `${fetched.status}\n${fetched.finalUrl}\n${fetched.text}`;
  const evaluated = evaluateTextCondition({
    condition,
    text: condition.type === "changed" ? canonical : fetched.text,
    hashText: canonical,
    previousHash: params.watch.lastResultHash,
  });
  const summary = truncateSummary(
    formatUrlConditionSummary({
      condition,
      evaluatedSummary: evaluated.summary,
      metadata: fetched,
    }),
  );
  if (!evaluated.triggered) {
    return {
      triggered: false,
      resultHash: evaluated.resultHash,
      summary,
      payload: {
        status: fetched.status,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        contentMode: fetched.contentMode,
      },
    };
  }
  return {
    triggered: true,
    resultHash: evaluated.resultHash,
    summary,
    notification: formatUrlNotification({
      watch: params.watch,
      condition,
      summary,
      fetched,
    }),
    payload: {
      status: fetched.status,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      contentMode: fetched.contentMode,
    },
  };
}
