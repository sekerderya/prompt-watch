/**
 * Model pricing in USD per 1k tokens.
 *
 * Keys are *base* model names. The OpenAI API echoes back a dated snapshot id
 * (e.g. "gpt-4o-mini-2024-07-18") rather than the alias you requested, so
 * `resolvePricing` does longest-prefix matching instead of an exact lookup.
 *
 * Prices change; this is the single place to update them.
 */
export interface ModelPricing {
  promptPricePer1k: number;
  completionPricePer1k: number;
}

export interface PricingResolution {
  pricing: ModelPricing;
  /** True when no table entry matched and DEFAULT_PRICING was used as a guess. */
  unknown: boolean;
  /** The table key that matched, or null when the price is a guess. */
  matchedKey: string | null;
}

/**
 * Used only when a model is not in the table. Callers must surface
 * `unknown: true` so a guessed price is never presented as a measured one.
 */
export const DEFAULT_PRICING: ModelPricing = {
  promptPricePer1k: 0.0025,
  completionPricePer1k: 0.01,
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { promptPricePer1k: 0.0025, completionPricePer1k: 0.01 },
  "gpt-4o-mini": { promptPricePer1k: 0.00015, completionPricePer1k: 0.0006 },
  "gpt-4-turbo": { promptPricePer1k: 0.01, completionPricePer1k: 0.03 },
  "gpt-4": { promptPricePer1k: 0.03, completionPricePer1k: 0.06 },
  "gpt-3.5-turbo": { promptPricePer1k: 0.0005, completionPricePer1k: 0.0015 },
};

/** Longest-first so "gpt-4o-mini" wins over "gpt-4o". */
function keysBySpecificity(table: Record<string, ModelPricing>): string[] {
  return Object.keys(table).sort((a, b) => b.length - a.length);
}

const DEFAULT_KEYS = keysBySpecificity(MODEL_PRICING);

/**
 * Resolve pricing for a model id, tolerating dated snapshot suffixes.
 *
 *   "gpt-4o-mini"            -> exact match
 *   "gpt-4o-mini-2024-07-18" -> prefix match on "gpt-4o-mini"
 *   "o3-pro"                 -> unknown: true, DEFAULT_PRICING
 *
 * `overrides` lets a host application price models the built-in table does not
 * know, or correct one whose price has changed, without forking the SDK.
 * Provider prices move faster than this package will be republished.
 */
export function resolvePricing(
  model: string | undefined | null,
  overrides?: Record<string, ModelPricing>
): PricingResolution {
  if (typeof model === "string" && model.length > 0) {
    const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
    const table = hasOverrides ? { ...MODEL_PRICING, ...overrides } : MODEL_PRICING;
    // An override wins over a built-in entry of the same specificity.
    const keys = hasOverrides ? keysBySpecificity(table) : DEFAULT_KEYS;

    for (const key of keys) {
      if (model === key || model.startsWith(`${key}-`)) {
        return { pricing: table[key], unknown: false, matchedKey: key };
      }
    }
  }
  return { pricing: DEFAULT_PRICING, unknown: true, matchedKey: null };
}
