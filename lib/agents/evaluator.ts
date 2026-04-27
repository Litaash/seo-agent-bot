import "server-only";

import { Output, ToolLoopAgent, tool } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { gscTool } from "@/lib/tools/gsc";
import { defaultStopWhen } from "@/lib/guardrails";
import { DEFAULT_MODEL } from "@/lib/cost";

import type { SubagentContext } from "@/lib/agents/keyword-researcher";

/**
 * System prompt for the evaluator subagent.
 *
 * Used in two places:
 *   - Weekly cron (`/api/cron/weekly-check`) — re-evaluates published
 *     articles and triggers a re-optimisation task when they're stuck
 *     past position 20.
 *   - On-demand from the orchestrator if the user asks "how is article
 *     X doing?" — same code path, same prompt.
 */
export const EVALUATOR_PROMPT = `You are an SEO performance analyst.

Given an article that has been published, your job is to read its Search
Console performance and decide what to do next.

Workflow:
1. Call \`gsc_query\` once to fetch the article's clicks, impressions, CTR
   and average position over the last 28 days, filtered on the article's
   page URL. Group by query so you can see which keywords actually
   surfaced it.
2. Optionally call \`gsc_query\` a second time grouped by date if you
   suspect a sudden ranking change. Never call the same tool with
   identical arguments twice.
3. Decide between three verdicts:
   - "keep"        — average position <= 10. The article is performing.
   - "refresh"     — average position 11-20, or position <= 10 but with
                     <50 impressions/month. Add depth, not a rewrite.
   - "re-optimize" — average position > 20, or position 11-20 with
                     declining trend. Rewrite for a different angle.

Output requirements:
- A short \`summary\` (1-2 sentences) of the article's current performance.
- A \`verdict\` enum from the three options above.
- A \`recommended_action\` string the orchestrator can act on:
   - For "keep" — what to monitor next.
   - For "refresh" — which sections/keywords to expand.
   - For "re-optimize" — what new primary keyword and angle to target.
- Top 3 query strings the article is actually ranking for, even if poorly.

You MUST end the run by emitting the structured \`evaluation_report\` JSON
object — never plain text. Do not call \`gsc_query\` more than twice.`;

/**
 * Schema for the evaluation report.
 *
 * The cron handler reads `verdict` to decide whether to spawn a
 * re-optimisation task; the dashboard surfaces `summary` and
 * `recommended_action` to the user.
 */
export const evaluationReportOutputSchema = z.object({
  summary: z
    .string()
    .min(10)
    .describe("1-2 sentence performance summary, plain language."),
  verdict: z
    .enum(["keep", "refresh", "re-optimize"])
    .describe(
      "Action category. Cron uses this to decide whether to spawn a re-optimisation task.",
    ),
  recommended_action: z
    .string()
    .min(10)
    .describe(
      "Concrete next step in 1-3 sentences. For 're-optimize', include the new primary keyword and angle.",
    ),
  metrics: z
    .object({
      avg_position: z.number().describe("Average SERP position from GSC."),
      clicks: z.number().int().describe("Total clicks in the window."),
      impressions: z.number().int().describe("Total impressions in the window."),
      ctr: z
        .number()
        .describe("Click-through rate as a fraction (0..1) from GSC."),
    })
    .describe("Headline metrics, copied from GSC for the article's page filter."),
  top_queries: z
    .array(z.string())
    .max(3)
    .describe("Up to 3 query strings the article actually surfaces for."),
});

export type EvaluationReport = z.infer<typeof evaluationReportOutputSchema>;

/**
 * Subagent that reads GSC and returns a verdict. Only one tool, low step
 * count — evaluation is a tight, deterministic loop.
 */
export const evaluatorAgent = new ToolLoopAgent({
  id: "evaluator",
  model: google(DEFAULT_MODEL),
  instructions: EVALUATOR_PROMPT,
  tools: {
    gsc_query: gscTool,
  },
  stopWhen: defaultStopWhen({ maxSteps: 5, maxTokens: 10_000 }),
  output: Output.object({
    schema: evaluationReportOutputSchema,
    name: "evaluation_report",
    description: "Performance verdict and next-action recommendation.",
  }),
});

export interface EvaluateArticleInput {
  /**
   * Verified Search Console property. URL-prefix property uses the
   * trailing-slash form ('https://example.com/'); domain property uses
   * 'sc-domain:example.com'. See `lib/tools/gsc.ts` for details.
   */
  siteUrl: string;
  /** Absolute URL of the article we're evaluating. */
  pageUrl: string;
  /** Article title — used purely as context for the LLM's narrative. */
  title: string;
  /**
   * Optional ISO date strings (YYYY-MM-DD). Defaults: 28-day window
   * ending today, matching the GSC tool's defaults.
   */
  startDate?: string;
  endDate?: string;
  abortSignal?: AbortSignal;
}

/**
 * Standalone helper used by the weekly cron job. Does not require a
 * parent orchestrator — calls the evaluator subagent directly and
 * returns the structured report.
 */
export async function evaluateArticle(
  input: EvaluateArticleInput,
): Promise<EvaluationReport> {
  const promptParts = [
    `Article title: ${input.title}`,
    `Page URL: ${input.pageUrl}`,
    `Search Console property: ${input.siteUrl}`,
    input.startDate ? `Window start: ${input.startDate}` : null,
    input.endDate ? `Window end: ${input.endDate}` : null,
    "",
    "Pull the article's GSC performance and produce the evaluation_report JSON object.",
  ].filter(Boolean) as string[];

  const result = await evaluatorAgent.generate({
    prompt: promptParts.join("\n"),
    abortSignal: input.abortSignal,
  });

  return result.output;
}

/**
 * Vercel AI SDK tool the orchestrator can call when the user explicitly
 * asks for an article evaluation (rare in MVP — most evaluations come
 * from the weekly cron). Wired up the same way as the other subagent
 * tools so step costs roll up to the parent task.
 */
export const evaluateArticleSubagentTool = tool({
  description:
    "Delegate Search Console performance evaluation to the evaluator " +
    "subagent. Returns a verdict (keep / refresh / re-optimize) and a " +
    "concrete recommended action.",
  inputSchema: z.object({
    siteUrl: z
      .string()
      .min(1)
      .describe(
        "Verified Search Console property. URL-prefix uses trailing slash ('https://example.com/'); domain uses 'sc-domain:example.com'.",
      ),
    pageUrl: z
      .string()
      .url()
      .describe("Absolute URL of the article being evaluated."),
    title: z.string().min(1).describe("Article title for narrative context."),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Window start (YYYY-MM-DD); defaults to 28 days ago."),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Window end (YYYY-MM-DD); defaults to today."),
  }),
  execute: async (
    input,
    { abortSignal, experimental_context },
  ): Promise<EvaluationReport> => {
    const ctx = experimental_context as SubagentContext | undefined;

    const promptParts = [
      `Article title: ${input.title}`,
      `Page URL: ${input.pageUrl}`,
      `Search Console property: ${input.siteUrl}`,
      input.startDate ? `Window start: ${input.startDate}` : null,
      input.endDate ? `Window end: ${input.endDate}` : null,
      "",
      "Pull the article's GSC performance and produce the evaluation_report JSON object.",
    ].filter(Boolean) as string[];

    const result = await evaluatorAgent.generate({
      prompt: promptParts.join("\n"),
      abortSignal,
      onStepFinish: ctx?.onSubagentStep
        ? (step) => ctx.onSubagentStep!("evaluator", step)
        : undefined,
    });

    return result.output;
  },
});
