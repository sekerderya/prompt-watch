// Placeholder prices in USD per 1k tokens. Fill in current official prices from
// OpenAI's pricing page when they change; this is the single place to update them.
export interface ModelPricing {
  promptPricePer1k: number;
  completionPricePer1k: number;
}

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