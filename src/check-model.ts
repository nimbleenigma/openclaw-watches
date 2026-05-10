import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { loadModelCatalog } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { hashWatchResult } from "./evaluate.js";
import type { CheckOutcome, ModelWatchSource, WatchRecord } from "./types.js";

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function splitProviderModel(query: string): { provider?: string; model: string } {
  const trimmed = query.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex).trim(),
      model: trimmed.slice(slashIndex + 1).trim(),
    };
  }
  return { model: trimmed };
}

function entryMatchesQuery(entry: ModelCatalogEntry, source: ModelWatchSource): boolean {
  const parsed = splitProviderModel(source.query);
  const expectedProvider = normalize(source.provider ?? parsed.provider);
  if (expectedProvider && normalize(entry.provider) !== expectedProvider) {
    return false;
  }
  const expectedModel = normalize(source.model ?? parsed.model ?? source.query);
  if (!expectedModel) {
    return false;
  }
  const candidates = [entry.id, entry.name, entry.alias].map(normalize).filter(Boolean);
  return candidates.some(
    (candidate) => candidate === expectedModel || candidate.includes(expectedModel),
  );
}

export function findAvailableModel(
  catalog: readonly ModelCatalogEntry[],
  source: ModelWatchSource,
): ModelCatalogEntry | undefined {
  return catalog.find((entry) => entryMatchesQuery(entry, source));
}

export async function checkModelAvailability(params: {
  watch: WatchRecord;
  cfg: OpenClawConfig;
  loadCatalog?: typeof loadModelCatalog;
}): Promise<CheckOutcome> {
  if (params.watch.kind !== "model") {
    throw new Error(`Expected model watch, got ${params.watch.kind}`);
  }
  const source = params.watch.source as ModelWatchSource;
  const loadCatalogFn = params.loadCatalog ?? loadModelCatalog;
  const catalog = await loadCatalogFn({ config: params.cfg, useCache: false });
  const resultHash = hashWatchResult(
    catalog
      .map((entry) => `${entry.provider}/${entry.id}`)
      .toSorted()
      .join("\n"),
  );
  const match = findAvailableModel(catalog, source);
  if (!match) {
    return {
      triggered: false,
      resultHash,
      summary: `No available model matched ${source.query}.`,
    };
  }
  const modelLabel = `${match.provider}/${match.id}`;
  return {
    triggered: true,
    resultHash,
    summary: `Matched ${modelLabel}.`,
    notification: `Watch triggered: ${params.watch.title}\n\nAvailable model: ${modelLabel}`,
    payload: {
      provider: match.provider,
      id: match.id,
      name: match.name,
    },
  };
}
