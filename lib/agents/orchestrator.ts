import "server-only";

import {
  generateText,
  tool,
  type GenerateTextResult,
  type StepResult,
  type ToolSet,
} from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/server";
import {
  DEFAULT_MODEL,
  calculateCost,
  incrementTaskCost,
  trackAgentRun,
  type CostBreakdown,
} from "@/lib/cost";
import {
  assertWithinDailyBudget,
  defaultStopWhen,
  runTimeoutSignal,
  RUN_TIMEOUT_MS,
} from "@/lib/guardrails";

import {
  researchKeywordsSubagentTool,
  type SubagentContext,
} from "@/lib/agents/keyword-researcher";
import {
  articleDraftOutputSchema,
  generateContentSubagentTool,
} from "@/lib/agents/content-generator";

/**
 * System prompt for the orchestrator agent.
 *
 * The orchestrator is intentionally short-circuited: its only job is to
 * sequence three tool calls (research → generate → save) and stop.
 * Because every subagent already enforces its own quality bar, the
 * orchestrator does not second-guess the brief or the draft.
 */
export const ORCHESTRATOR_PROMPT = `You are the SEO agent orchestrator.

Your only job is to sequence three tool calls in this exact order:

1. \`research_keywords\` — pass the user's topic (and geo/hl when given).
   Returns a structured keyword brief.
2. \`generate_content\` — pass the brief from step 1 verbatim plus the
   target language. Returns the finished article draft.
3. \`save_draft\` — pass the draft from step 2 verbatim. This stops the
   run by transitioning the task to 'awaiting_approval'.

Rules:
- Never paraphrase tool outputs before passing them downstream — pass the
  JSON exactly as returned. Re-summarising wastes tokens and degrades the
  brief the content generator depends on.
- Never call any tool more than once. If a tool fails, stop the run and
  let the human inspect the error — do not retry.
- Never produce free-form prose between tool calls beyond a single short
  sentence acknowledging which step you are on. The dashboard shows the
  tool calls themselves; commentary is noise.
- After \`save_draft\` returns, end the run. Do not say anything else.`;

/**
 * Result returned to the API route after a successful run.
 *
 * `articleId` is the row written by `save_draft`; the dashboard redirects
 * to `/tasks/[id]` and surfaces the article preview + Approve button.
 */
export interface OrchestratorResult {
  taskId: string;
  articleId: string;
  cost: CostBreakdown;
  stepCount: number;
  finishReason: GenerateTextResult<ToolSet, never>["finishReason"];
}

export interface RunOrchestratorInput {
  /** UUID of the parent `tasks` row. Must already exist. */
  taskId: string;
  /** Topic the user supplied via the dashboard. */
  topic: string;
  /** Country code for Google Trends. Defaults to 'US'. */
  geo?: string;
  /** UI language code for Google Trends. Defaults to 'en-US'. */
  hl?: string;
  /**
   * Human-readable target language for the article ("English",
   * "Ukrainian", ...). Defaults to "English".
   */
  language?: string;
  /**
   * Optional editorial voice override forwarded to the content generator.
   */
  voice?: string;
  /**
   * Optional override for the run's wall-clock timeout. Defaults to
   * `RUN_TIMEOUT_MS` (5 minutes).
   */
  timeoutMs?: number;
}

interface OrchestratorContext extends SubagentContext {
  taskId: string;
}

interface SaveDraftToolOutput {
  articleId: string;
  status: "saved_for_approval";
}

/**
 * Insert one row per atomic action inside a step into `agent_steps`.
 *
 * The schema's `step_type` column is constrained to
 * `think|tool_call|tool_result|content|error`, so a single LLM step often
 * fans out into multiple rows: one `think` row per reasoning block, one
 * `tool_call` per call, one `tool_result` per result, one `content` row
 * for any final text. Token + cost numbers are attached to whichever row
 * is the natural "summary" so totals reconcile with `agent_runs`.
 */
async function logOrchestratorStep(
  taskId: string,
  step: StepResult<ToolSet>,
  cost: CostBreakdown,
): Promise<void> {
  const supabase = createAdminClient();

  type StepRow = {
    task_id: string;
    step_type: "think" | "tool_call" | "tool_result" | "content" | "error";
    content: Record<string, unknown>;
    tokens_in?: number;
    tokens_out?: number;
    cost_usd?: number;
  };

  const rows: StepRow[] = [];

  if (step.reasoningText) {
    rows.push({
      task_id: taskId,
      step_type: "think",
      content: { text: step.reasoningText, stepNumber: step.stepNumber },
    });
  }

  for (const call of step.toolCalls) {
    rows.push({
      task_id: taskId,
      step_type: "tool_call",
      content: {
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        input: call.input,
        stepNumber: step.stepNumber,
      },
    });
  }

  for (const result of step.toolResults) {
    // AI SDK marks failed tool executions with `type: "tool-error"` (and
    // an `error` field) instead of a normal `output`. We surface those as
    // explicit `error` rows so the live UI shows the real cause instead
    // of just "the tool failed" written by the orchestrator-LLM.
    const r = result as unknown as {
      type?: string;
      toolName: string;
      toolCallId: string;
      output?: unknown;
      error?: unknown;
    };
    const isToolError =
      r.type === "tool-error" ||
      r.error !== undefined ||
      (typeof r.output === "object" &&
        r.output !== null &&
        "error" in (r.output as Record<string, unknown>));

    if (isToolError) {
      const rawErr =
        r.error ??
        (r.output as { error?: unknown } | undefined)?.error ??
        r.output;
      const message =
        rawErr instanceof Error
          ? rawErr.message
          : typeof rawErr === "string"
            ? rawErr
            : JSON.stringify(rawErr);
      rows.push({
        task_id: taskId,
        step_type: "error",
        content: {
          toolName: r.toolName,
          toolCallId: r.toolCallId,
          message,
          name: rawErr instanceof Error ? rawErr.name : "ToolError",
          stepNumber: step.stepNumber,
        },
      });
      continue;
    }

    rows.push({
      task_id: taskId,
      step_type: "tool_result",
      content: {
        toolName: r.toolName,
        toolCallId: r.toolCallId,
        output: r.output,
        stepNumber: step.stepNumber,
      },
    });
  }

  if (step.text) {
    rows.push({
      task_id: taskId,
      step_type: "content",
      content: { text: step.text, stepNumber: step.stepNumber },
    });
  }

  if (rows.length === 0) {
    rows.push({
      task_id: taskId,
      step_type: "content",
      content: { stepNumber: step.stepNumber, note: "empty_step" },
    });
  }

  // Attach cost/usage to the last row only — that way summing a task's
  // cost_usd column over all rows equals the total spend, and the live UI
  // can show "+$0.0023" beside the most informative event of each step.
  const tail = rows[rows.length - 1];
  tail.tokens_in = cost.inputTokens;
  tail.tokens_out = cost.outputTokens;
  tail.cost_usd = cost.costUsd;

  const { error } = await supabase.from("agent_steps").insert(rows);
  if (error) {
    // Logging failures are non-fatal — we'd rather lose a UI breadcrumb
    // than abort the agent run. Surface to server logs for debugging.
    console.error("[orchestrator] agent_steps insert failed:", error);
  }
}

/**
 * Build the `save_draft` tool with the current task baked in via
 * closure. We could read the taskId from `experimental_context`, but
 * making it a closure variable means the tool can't be misused from a
 * different run in the same process.
 */
function createSaveDraftTool(taskId: string) {
  return tool({
    description:
      "Persist the finished article draft as an `articles` row and move " +
      "the task to `awaiting_approval`. Call this exactly once with the " +
      "draft returned by `generate_content`. Calling this tool ends the " +
      "run.",
    inputSchema: articleDraftOutputSchema,
    execute: async (draft): Promise<SaveDraftToolOutput> => {
      const supabase = createAdminClient();

      const { data, error: insertErr } = await supabase
        .from("articles")
        .insert({
          task_id: taskId,
          title: draft.title,
          content_md: draft.content_md,
          keywords: draft.keywords,
        })
        .select("id")
        .single();

      if (insertErr || !data) {
        throw new Error(
          `Failed to insert article: ${insertErr?.message ?? "unknown error"}`,
        );
      }

      const { error: updateErr } = await supabase
        .from("tasks")
        .update({ status: "awaiting_approval" })
        .eq("id", taskId);

      if (updateErr) {
        throw new Error(
          `Article saved but failed to flip task status to awaiting_approval: ${updateErr.message}`,
        );
      }

      return { articleId: data.id as string, status: "saved_for_approval" };
    },
  });
}

/**
 * Run a complete `topic → article draft` pipeline for a task.
 *
 * Flow:
 *   1. Pre-flight daily budget check (throws DailyBudgetExceededError).
 *   2. Flip task status to 'running' for live UI.
 *   3. `generateText` with the three tools and the standard guardrail
 *      stack. The orchestrator's own prompt forces sequential calls.
 *   4. `onStepFinish` (orchestrator + each subagent) logs steps and
 *      attributes cost. Cost is rolled into `agent_runs` and
 *      `tasks.cost_usd` so the daily-budget guardrail stays accurate.
 *   5. On success: `save_draft` already moved the task to
 *      `awaiting_approval` and inserted the article. Return its id.
 *   6. On failure: flip the task to `failed` and rethrow so the API
 *      route can surface a 5xx with a useful message.
 */
export async function runOrchestrator(
  input: RunOrchestratorInput,
): Promise<OrchestratorResult> {
  const {
    taskId,
    topic,
    geo = "US",
    hl = "en-US",
    language = "English",
    voice,
    timeoutMs = RUN_TIMEOUT_MS,
  } = input;

  await assertWithinDailyBudget();

  const supabase = createAdminClient();
  const { error: statusErr } = await supabase
    .from("tasks")
    .update({ status: "running" })
    .eq("id", taskId);
  if (statusErr) {
    throw new Error(
      `Failed to flip task ${taskId} to 'running': ${statusErr.message}`,
    );
  }

  // ---- per-step + per-subagent-step cost tracking ------------------------
  let savedArticleId: string | null = null;

  const trackStep = async (step: StepResult<ToolSet>): Promise<CostBreakdown> => {
    const modelId = step.model?.modelId ?? DEFAULT_MODEL;
    const breakdown = await trackAgentRun({
      taskId,
      model: modelId,
      usage: step.usage,
    });
    await incrementTaskCost(taskId, breakdown.costUsd);
    return breakdown;
  };

  // Subagent-side handler: we DON'T write to agent_steps (subagent
  // internals are intentionally hidden in the live UI), but we DO charge
  // each step to the same task so the daily budget stays honest.
  const onSubagentStep = async (
    _subagentId: string,
    step: StepResult<ToolSet>,
  ): Promise<void> => {
    await trackStep(step);
  };

  const ctx: OrchestratorContext = { taskId, onSubagentStep };

  const tools = {
    research_keywords: researchKeywordsSubagentTool,
    generate_content: generateContentSubagentTool,
    save_draft: createSaveDraftTool(taskId),
  } satisfies ToolSet;

  // ---- run the orchestrator ---------------------------------------------
  try {
    const result = await generateText({
      model: google(DEFAULT_MODEL),
      system: ORCHESTRATOR_PROMPT,
      tools,
      // The orchestrator stops *as soon as* save_draft is called, so we
      // never pay for an extra LLM step after the article is persisted.
      stopWhen: defaultStopWhen({
        maxSteps: 8,
        maxTokens: 50_000,
        finalTool: "save_draft",
      }),
      abortSignal: runTimeoutSignal(timeoutMs),
      experimental_context: ctx,
      prompt:
        `Topic: ${topic}\n` +
        `Geo: ${geo}\n` +
        `UI language (hl): ${hl}\n` +
        `Article language: ${language}\n` +
        (voice ? `Editorial voice: ${voice}\n` : "") +
        `\nRun the three-step pipeline.`,
      onStepFinish: async (step) => {
        const breakdown = await trackStep(step);
        await logOrchestratorStep(taskId, step, breakdown);

        // Capture the article id from the save_draft tool result. The
        // tool already updated tasks.status; here we just remember which
        // article row to return to the caller.
        for (const r of step.toolResults) {
          if (r.toolName === "save_draft") {
            const out = r.output as SaveDraftToolOutput;
            savedArticleId = out.articleId;
          }
        }
      },
    });

    if (!savedArticleId) {
      throw new Error(
        `Orchestrator finished without calling save_draft (finishReason=${result.finishReason}).`,
      );
    }

    // Snapshot the run-level cost using the SDK's own totalUsage so the
    // returned figure matches what the model billed end-to-end (including
    // any rounding the SDK applies internally).
    const runCost = calculateCost(result.totalUsage, DEFAULT_MODEL);

    return {
      taskId,
      articleId: savedArticleId,
      cost: runCost,
      stepCount: result.steps.length,
      finishReason: result.finishReason,
    };
  } catch (err) {
    // Best-effort: flip the task to 'failed' and write an error step so
    // the dashboard shows what went wrong. We still rethrow so the API
    // route returns a 5xx.
    const message = err instanceof Error ? err.message : String(err);

    await supabase
      .from("tasks")
      .update({ status: "failed" })
      .eq("id", taskId);

    await supabase.from("agent_steps").insert({
      task_id: taskId,
      step_type: "error",
      content: { message, name: err instanceof Error ? err.name : "Error" },
    });

    throw err;
  }
}

/**
 * Zod schema mirroring `RunOrchestratorInput`. Exposed so the API route
 * can `.parse()` the request body without re-declaring the shape.
 */
export const runOrchestratorInputSchema = z.object({
  taskId: z.string().uuid(),
  topic: z.string().min(2).max(200),
  geo: z.string().min(2).max(8).optional(),
  hl: z.string().min(2).max(10).optional(),
  language: z.string().min(2).max(40).optional(),
  voice: z.string().max(80).optional(),
  timeoutMs: z.number().int().positive().max(15 * 60 * 1000).optional(),
});
