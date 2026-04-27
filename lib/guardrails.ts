import "server-only";

import {
  hasToolCall,
  stepCountIs,
  type StopCondition,
  type ToolSet,
} from "ai";

import {
  DEFAULT_MODEL,
  getDailyBudgetUsd,
  getDailySpendUsd,
  sumStepCostUsd,
  sumStepTokens,
} from "@/lib/cost";

// ---------------------------------------------------------------------------
// Tunable defaults — keep aligned with `docs/PRD.md` and the orchestrator.
// ---------------------------------------------------------------------------

/** Hard cap on tool-loop iterations the agent may take in one run. */
export const MAX_STEPS = 20;

/** Hard cap on cumulative LLM tokens (input + output) across the run. */
export const MAX_TOTAL_TOKENS = 50_000;

/**
 * Number of times the same `(tool, args)` pair may appear before the run is
 * aborted. Three is a sweet spot: legitimate retries (e.g. transient SERP
 * fetch failures) usually settle in 1–2 retries, while a stuck loop will
 * fire the same pair indefinitely.
 */
export const LOOP_REPEAT_THRESHOLD = 3;

/**
 * Wall-clock timeout for an entire orchestrator run (4 minutes).
 *
 * Sized below Vercel's Hobby-plan 300s Function `maxDuration` so our
 * `AbortSignal` fires first and we can flush a final SSE frame before
 * the platform kills the request.
 */
export const RUN_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Default per-task cost ceiling. Generous headroom over the ~$0.03 expected
 * spend per cycle so the agent isn't tripped by a one-off pricier run, but
 * far below a single day's budget so a single runaway task can't blow it.
 */
export const DEFAULT_TASK_BUDGET_USD = 0.5;

// ---------------------------------------------------------------------------
// Stop conditions (composable factories)
// ---------------------------------------------------------------------------

/**
 * Stop when the cumulative token usage across all completed steps reaches
 * `limit`. Use in addition to `stepCountIs(...)` — step count alone doesn't
 * bound spending if a single step pulls in a huge tool result.
 */
export function tokenBudgetIs<T extends ToolSet = ToolSet>(
  limit: number = MAX_TOTAL_TOKENS,
): StopCondition<T> {
  return ({ steps }) => sumStepTokens(steps) >= limit;
}

/**
 * Stop when the agent has spent more than `limitUsd` on this task. Reads
 * each step's `model.modelId` so multi-model runs are priced correctly.
 */
export function costBudgetIs<T extends ToolSet = ToolSet>(
  limitUsd: number = DEFAULT_TASK_BUDGET_USD,
  fallbackModel: string = DEFAULT_MODEL,
): StopCondition<T> {
  return ({ steps }) => sumStepCostUsd(steps, fallbackModel) >= limitUsd;
}

/**
 * Deterministic JSON serializer used as the loop-detection key. Sorts
 * object keys so `{a:1,b:2}` and `{b:2,a:1}` collapse to one signature.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Stop when the agent has called the same `(tool, args)` pair `threshold`
 * times across the run.
 *
 * Counts grow monotonically, so once we hit the threshold the very next
 * `stopWhen` evaluation aborts the run. This catches the most common
 * runaway pattern: an agent that re-runs `serp_analysis` with identical
 * arguments hoping for a different answer.
 */
export function detectLoop<T extends ToolSet = ToolSet>(
  threshold: number = LOOP_REPEAT_THRESHOLD,
): StopCondition<T> {
  return ({ steps }) => {
    const counts = new Map<string, number>();
    for (const step of steps) {
      for (const call of step.toolCalls) {
        const key = `${call.toolName}:${stableStringify(call.input)}`;
        const next = (counts.get(key) ?? 0) + 1;
        if (next >= threshold) return true;
        counts.set(key, next);
      }
    }
    return false;
  };
}

export interface DefaultStopWhenOptions {
  /** Override the step-count cap (default: `MAX_STEPS`). */
  maxSteps?: number;
  /** Override the token-budget cap (default: `MAX_TOTAL_TOKENS`). */
  maxTokens?: number;
  /** Override the loop-detection threshold (default: `LOOP_REPEAT_THRESHOLD`). */
  loopThreshold?: number;
  /** Per-task USD cost cap; omit to skip the cost-budget condition. */
  maxCostUsd?: number;
  /**
   * Tool name(s) whose first invocation should terminate the run. The
   * orchestrator's MVP uses `"save_draft"` so the agent can declare
   * "I'm done — here's the article" by calling that tool once.
   */
  finalTool?: string | string[];
  /** Fallback model id for cost calculation when a step lacks `model.modelId`. */
  fallbackModel?: string;
}

/**
 * Standard guardrail bundle used by the orchestrator. Pass directly into
 * `stopWhen:` on `generateText` / `streamText` / `Agent`.
 *
 * Intentionally returns an array so callers can spread additional
 * conditions: `stopWhen: [...defaultStopWhen(), customCondition]`.
 *
 * Returns `StopCondition<any>[]` to match the SDK's own helpers
 * (`stepCountIs`, `hasToolCall` both return `StopCondition<any>`).
 * Generic-typed stop conditions hit a TS variance wall when assigned to
 * `ToolLoopAgent`/`generateText` because their inferred `TOOLS` shape is
 * narrower than the `ToolSet` Record alias — widening here keeps the
 * helper plug-and-play across every agent in the codebase.
 */
// Returns StopCondition<any>[] to match the SDK's own helpers
// (stepCountIs/hasToolCall both return StopCondition<any>) so this bundle
// is assignable to any agent's stopWhen, regardless of the agent's
// inferred TOOLS shape.
export function defaultStopWhen(
  options: DefaultStopWhenOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StopCondition<any>[] {
  const {
    maxSteps = MAX_STEPS,
    maxTokens = MAX_TOTAL_TOKENS,
    loopThreshold = LOOP_REPEAT_THRESHOLD,
    maxCostUsd,
    finalTool,
    fallbackModel = DEFAULT_MODEL,
  } = options;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: StopCondition<any>[] = [
    stepCountIs(maxSteps),
    tokenBudgetIs(maxTokens),
    detectLoop(loopThreshold),
  ];

  if (typeof maxCostUsd === "number") {
    conditions.push(costBudgetIs(maxCostUsd, fallbackModel));
  }

  if (finalTool) {
    const tools = Array.isArray(finalTool) ? finalTool : [finalTool];
    for (const t of tools) {
      conditions.push(hasToolCall(t));
    }
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Daily budget pre-check
// ---------------------------------------------------------------------------

/**
 * Thrown when today's spend has already met or exceeded `DAILY_BUDGET_USD`.
 * The route handler should catch this and return HTTP 429 so the dashboard
 * can show a friendly "come back tomorrow" message.
 */
export class DailyBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;
  constructor(spentUsd: number, limitUsd: number) {
    super(
      `Daily LLM budget exceeded: $${spentUsd.toFixed(4)} spent of $${limitUsd.toFixed(2)} cap.`,
    );
    this.name = "DailyBudgetExceededError";
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

/**
 * Pre-flight check: refuse to start a new agent run if today's cumulative
 * cost has already met `DAILY_BUDGET_USD`. The hard cutoff is the cap
 * itself — runs are not allowed to start exactly *at* the cap because
 * even a minimal step would push us over.
 */
export async function assertWithinDailyBudget(): Promise<{
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
}> {
  const [spentUsd, limitUsd] = await Promise.all([
    getDailySpendUsd(),
    Promise.resolve(getDailyBudgetUsd()),
  ]);
  if (spentUsd >= limitUsd) {
    throw new DailyBudgetExceededError(spentUsd, limitUsd);
  }
  return { spentUsd, limitUsd, remainingUsd: round6(limitUsd - spentUsd) };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Run timeout
// ---------------------------------------------------------------------------

/** Thrown when a run exceeds `RUN_TIMEOUT_MS` (or a caller-supplied limit). */
export class RunTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Agent run exceeded timeout of ${timeoutMs}ms.`);
    this.name = "RunTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `promise` against a timeout. Prefer this over a bare `setTimeout`
 * because it cleans up the timer on resolution — important inside Vercel
 * Functions where leaked timers keep the lambda warm.
 */
export function withRunTimeout<T>(
  promise: Promise<T>,
  ms: number = RUN_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build an `AbortSignal` that fires after `ms`. Pass to `generateText`'s
 * `abortSignal:` so the AI SDK cancels in-flight HTTP requests cleanly,
 * unlike `withRunTimeout` which only rejects the awaited promise.
 *
 * Uses `AbortSignal.timeout` when available (Node ≥18 / modern browsers)
 * and falls back to a manual controller for older runtimes.
 */
export function runTimeoutSignal(ms: number = RUN_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new RunTimeoutError(ms)), ms);
  return controller.signal;
}
