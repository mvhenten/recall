import type { ModelTotals, TokenCounts } from "./model";

// Anthropic's published list prices in US dollars per million tokens. A cache write is the
// five-minute write rate, 1.25x input, and a cache read is 0.1x input. Tokens are stored and the
// money is worked out here on every read, so correcting a price needs no backfill. The dashboard
// and the connector's usage tools both price off this one table, so a figure read in a chat is the
// figure the page draws.
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const perMillion = (input: number, output: number): Price => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: input * 0.1,
});

const FABLE = perMillion(10, 50);
const OPUS = perMillion(5, 25);
const SONNET = perMillion(3, 15);
const HAIKU = perMillion(1, 5);

const CLAUDE_FAMILIES: Array<[RegExp, Price]> = [
  [/^claude-(fable|mythos)\b/, FABLE],
  [/^claude-opus\b/, OPUS],
  [/^claude-sonnet\b/, SONNET],
  [/^claude-haiku\b/, HAIKU],
];

// The hooks send "claude"; a delta recorded by another client may name the vendor instead.
const PROVIDERS = new Map<string, Array<[RegExp, Price]>>([
  ["claude", CLAUDE_FAMILIES],
  ["anthropic", CLAUDE_FAMILIES],
]);

const MILLION = 1_000_000;

export const priceOf = (provider: string, model: string): Price | null => {
  const families = PROVIDERS.get(provider.toLowerCase());
  if (!families) return null;
  return families.find(([family]) => family.test(model.toLowerCase()))?.[1] ?? null;
};

export const costOf = (totals: ModelTotals): number | null => {
  const price = priceOf(totals.provider, totals.model);
  if (!price) return null;
  return (
    (totals.inputTokens * price.input +
      totals.outputTokens * price.output +
      totals.cacheWriteTokens * price.cacheWrite +
      totals.cacheReadTokens * price.cacheRead) /
    MILLION
  );
};

export const spent = (totals: ModelTotals[]): number => totals.reduce((sum, entry) => sum + (costOf(entry) ?? 0), 0);

export const pricedIn = (models: ModelTotals[]): number =>
  models.filter((model) => priceOf(model.provider, model.model) !== null).length;

export const unpricedIn = (models: ModelTotals[]): string[] => [
  ...new Set(models.filter((model) => priceOf(model.provider, model.model) === null).map((model) => model.model)),
];

const NOTHING: TokenCounts = {
  prompts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

export const totalled = (rows: TokenCounts[]): TokenCounts =>
  rows.reduce(
    (sum, row) => ({
      prompts: sum.prompts + row.prompts,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    }),
    NOTHING,
  );

export const countedTokens = (counts: TokenCounts): number =>
  counts.inputTokens + counts.outputTokens + counts.cacheWriteTokens + counts.cacheReadTokens;

export const cacheHit = (counts: TokenCounts): number => {
  const fresh = counts.inputTokens + counts.cacheReadTokens;
  return fresh === 0 ? 0 : counts.cacheReadTokens / fresh;
};

export const keyOf = (totals: ModelTotals): string => `${totals.provider} ${totals.model}`;

export const byModel = (rows: ModelTotals[]): ModelTotals[] => {
  const merged = new Map<string, ModelTotals[]>();
  for (const row of rows) merged.set(keyOf(row), [...(merged.get(keyOf(row)) ?? []), row]);
  return [...merged.values()]
    .flatMap((group) => {
      const first = group[0];
      return first ? [{ provider: first.provider, model: first.model, ...totalled(group) }] : [];
    })
    .sort((left, right) => (costOf(right) ?? -1) - (costOf(left) ?? -1));
};

// The four token classes a reading is kept in, never folded into one number: a cache read costs a
// tenth of fresh input, so the mix is what a price comparison turns on and a lone total hides it.
// `cost` is null where readings were found and no model in them carries a price, so an unpriced
// model never reads as free; a window that holds no readings at all costs nothing and says 0.
// `costIsFloor` marks a mix of priced and unpriced, which is what the dashboard draws as "≈ $x".
export interface TokenReport {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  cost: number | null;
  costIsFloor: boolean;
  unpricedModels: string[];
}

const ROUNDED = 10_000;

export const tokenReport = (rows: ModelTotals[]): TokenReport => {
  const counts = totalled(rows);
  const priced = pricedIn(rows);
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
    totalTokens: countedTokens(counts),
    cacheHitRate: Math.round(cacheHit(counts) * ROUNDED) / ROUNDED,
    cost: priced === 0 && rows.length > 0 ? null : Math.round(spent(rows) * ROUNDED) / ROUNDED,
    costIsFloor: priced > 0 && priced < rows.length,
    unpricedModels: unpricedIn(rows),
  };
};

export interface ModelReport extends TokenReport {
  provider: string;
  model: string;
}

export const modelReports = (rows: ModelTotals[]): ModelReport[] =>
  byModel(rows).map((model) => ({ provider: model.provider, model: model.model, ...tokenReport([model]) }));

export const turnsIn = (rows: TokenCounts[]): number => totalled(rows).prompts;
