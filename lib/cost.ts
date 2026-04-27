import "server-only";

import type { LanguageModelUsage, StepResult, ToolSet } from "ai";

import { createAdminClient } from "@/lib/supabase/server";

/**
 * Per-1M-token pricing for an LLM. Numbers are in USD.
 *
 * Gemini 2.5 has tiered pricing for prompts >200K tokens; we deliberately
 * use the ≤200K tier because the orchestrator never approaches that ceiling
 * (its hard token budget is 50K — see `lib/guardrails.ts`).
 */
export interface ModelPricing {
  /** USD per 1M non-cached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-hit input tokens. Falls back to `input` if undefined. */
  cachedInput?: number;
}

/**
 * Gemini pricing (≤200K-token tier, Google AI Studio rates).
 *
 * Sources: Google AI Studio pricing page. Update if Google changes the
 * published rates — the cost calculation is purely a function of these
 * numbers and the `LanguageModelUsage` returned by the AI SDK.
 */
export const GEMINI_PRICING = {
  "gemini-2.5-flash":      { input: 0.30, output: 2.50, cachedInput: 0.075 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40, cachedInput: 0.025 },
  "gemini-2.5-pro":        { input: 1.25, output: 10.00, cachedInput: 0.31 },
} as const satisfies Record<string, ModelPricing>;

/** Default model the orchestrator uses; matches `lib/agents/orchestrator.ts`. */
export const DEFAULT_MODEL: keyof typeof GEMINI_PRICING = "gemini-2.5-flash";

/**
 * Resolve pricing for a model id. Strips a `google/` or `google:` provider
 * prefix if present, so callers can pass `step.model.modelId` directly.
 * Falls back to `DEFAULT_MODEL` for unknown ids — better to undercount than
 * to crash mid-run.
 */
export function getPricing(model: string): ModelPricing {
  const id = model.replace(/^google[/:]/, "").trim();
  return (
    (GEMINI_PRICING as Record<string, ModelPricing>)[id] ??
    GEMINI_PRICING[DEFAULT_MODEL]
  );
}

export interface CostBreakdown {
  /** Total input tokens (cached + uncached). */
  inputTokens: number;
  /** Subset of `inputTokens` that hit the prompt cache. */
  cachedInputTokens: number;
  /** Output tokens (text + reasoning). */
  outputTokens: number;
  /** Computed cost in USD, rounded to 6 decimals to match the schema. */
  costUsd: number;
}

/**
 * Round to 6 decimal places — matches the `numeric(10, 6)` precision used
 * by `tasks.cost_usd` and `agent_runs.cost_usd`. Storing more digits would
 * be silently truncated on insert.
 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Convert `LanguageModelUsage` into a `CostBreakdown` for the given model.
 * Cached input tokens are billed at the cheaper cache rate when available.
 *
 * The `usage` argument is intentionally typed as a partial structure: the
 * AI SDK's older shapes had `cachedInputTokens` directly, while the newer
 * shape nests it inside `inputTokenDetails.cacheReadTokens`. We support
 * both so this module keeps working across SDK upgrades.
 */
export function calculateCost(
  usage: Pick<
    LanguageModelUsage,
    "inputTokens" | "outputTokens" | "inputTokenDetails" | "cachedInputTokens"
  >,
  model: string = DEFAULT_MODEL,
): CostBreakdown {
  const pricing = getPricing(model);

  const totalInput = usage.inputTokens ?? 0;
  const cachedInput =
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const freshInput = Math.max(totalInput - cachedInput, 0);
  const output = usage.outputTokens ?? 0;

  const cost =
    (freshInput * pricing.input) / 1_000_000 +
    (cachedInput * (pricing.cachedInput ?? pricing.input)) / 1_000_000 +
    (output * pricing.output) / 1_000_000;

  return {
    inputTokens: totalInput,
    cachedInputTokens: cachedInput,
    outputTokens: output,
    costUsd: round6(cost),
  };
}

/**
 * Sum a list of `LanguageModelUsage` objects into one. Useful when you have
 * a stream of step usages and want a single cost figure for the whole run.
 */
export function sumUsage(
  usages: ReadonlyArray<LanguageModelUsage | undefined>,
): LanguageModelUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedReadTokens = 0;
  let cachedWriteTokens = 0;
  let noCacheTokens = 0;
  let totalTokens = 0;
  let textTokens = 0;
  let reasoningTokens = 0;
  let sawTotalTokens = false;
  let sawInputDetails = false;
  let sawOutputDetails = false;

  for (const u of usages) {
    if (!u) continue;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    if (typeof u.totalTokens === "number") {
      totalTokens += u.totalTokens;
      sawTotalTokens = true;
    }
    if (u.inputTokenDetails) {
      cachedReadTokens += u.inputTokenDetails.cacheReadTokens ?? 0;
      cachedWriteTokens += u.inputTokenDetails.cacheWriteTokens ?? 0;
      noCacheTokens += u.inputTokenDetails.noCacheTokens ?? 0;
      sawInputDetails = true;
    }
    if (u.outputTokenDetails) {
      textTokens += u.outputTokenDetails.textTokens ?? 0;
      reasoningTokens += u.outputTokenDetails.reasoningTokens ?? 0;
      sawOutputDetails = true;
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: sawTotalTokens ? totalTokens : inputTokens + outputTokens,
    inputTokenDetails: sawInputDetails
      ? {
          noCacheTokens,
          cacheReadTokens: cachedReadTokens,
          cacheWriteTokens: cachedWriteTokens,
        }
      : { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: sawOutputDetails
      ? { textTokens, reasoningTokens }
      : { textTokens: undefined, reasoningTokens: undefined },
  };
}

/**
 * Total token usage across an array of `StepResult`s. The orchestrator's
 * `stopWhen` token-budget condition (in `lib/guardrails.ts`) reads this.
 */
export function sumStepTokens<T extends ToolSet>(
  steps: ReadonlyArray<StepResult<T>>,
): number {
  let total = 0;
  for (const s of steps) {
    if (typeof s.usage.totalTokens === "number") {
      total += s.usage.totalTokens;
    } else {
      total += (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0);
    }
  }
  return total;
}

/**
 * Total cost across an array of `StepResult`s, summing the per-step usages
 * and pricing each step against its own `model.modelId` (so multi-model
 * runs cost out correctly).
 */
export function sumStepCostUsd<T extends ToolSet>(
  steps: ReadonlyArray<StepResult<T>>,
  fallbackModel: string = DEFAULT_MODEL,
): number {
  let total = 0;
  for (const s of steps) {
    const model = s.model?.modelId ?? fallbackModel;
    total += calculateCost(s.usage, model).costUsd;
  }
  return round6(total);
}

export interface TrackAgentRunInput {
  /** UUID of the parent task. May be null for ad-hoc runs (e.g. cron probes). */
  taskId: string | null;
  /** Model id used for the call (e.g. `"gemini-2.5-flash"`). */
  model: string;
  /** Aggregated token usage for the run/step. */
  usage: Pick<
    LanguageModelUsage,
    "inputTokens" | "outputTokens" | "inputTokenDetails" | "cachedInputTokens"
  >;
}

/**
 * Persist a single LLM call to `agent_runs` and return the computed cost.
 *
 * This is the single chokepoint for cost tracking in the project: every
 * `generateText`/`streamText` call should funnel its `usage` through here
 * (typically inside `onStepFinish` or `onFinish`), so the daily-budget
 * guardrail in `lib/guardrails.ts` reads consistent data.
 */
export async function trackAgentRun(
  input: TrackAgentRunInput,
): Promise<CostBreakdown> {
  const breakdown = calculateCost(input.usage, input.model);
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_runs").insert({
    task_id: input.taskId,
    model: input.model,
    input_tokens: breakdown.inputTokens,
    output_tokens: breakdown.outputTokens,
    cost_usd: breakdown.costUsd,
  });
  if (error) {
    throw new Error(`Failed to insert agent_runs row: ${error.message}`);
  }
  return breakdown;
}

/**
 * Atomically add `deltaUsd` to `tasks.cost_usd` for live UI rendering.
 *
 * Postgres has no built-in `update ... set x = x + ?` via the REST client,
 * so we read-then-write under the service-role key. Concurrent writes for
 * the same task are unlikely in this single-writer architecture; if that
 * ever changes, swap this for a `rpc()` call to a SQL function with a row
 * lock.
 */
export async function incrementTaskCost(
  taskId: string,
  deltaUsd: number,
): Promise<void> {
  if (!Number.isFinite(deltaUsd) || deltaUsd === 0) return;
  const supabase = createAdminClient();
  const { data, error: readErr } = await supabase
    .from("tasks")
    .select("cost_usd")
    .eq("id", taskId)
    .single();
  if (readErr) {
    throw new Error(`Failed to read tasks.cost_usd: ${readErr.message}`);
  }
  const next = round6(Number(data?.cost_usd ?? 0) + deltaUsd);
  const { error: writeErr } = await supabase
    .from("tasks")
    .update({ cost_usd: next })
    .eq("id", taskId);
  if (writeErr) {
    throw new Error(`Failed to update tasks.cost_usd: ${writeErr.message}`);
  }
}

/**
 * Read the configured daily budget cap (USD). Defaults to $1.00 — chosen
 * to leave generous headroom on the project's $5 of Google AI credits.
 */
export function getDailyBudgetUsd(): number {
  const raw = process.env.DAILY_BUDGET_USD;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

/**
 * Sum of `agent_runs.cost_usd` since UTC midnight today. The daily-budget
 * guardrail uses this both as a pre-flight check and for dashboard display.
 */
export async function getDailySpendUsd(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .select("cost_usd")
    .gte("created_at", startOfDay.toISOString());
  if (error) {
    throw new Error(`Failed to read daily spend: ${error.message}`);
  }
  let total = 0;
  for (const row of data ?? []) {
    total += Number((row as { cost_usd: number | null }).cost_usd ?? 0);
  }
  return round6(total);
}
