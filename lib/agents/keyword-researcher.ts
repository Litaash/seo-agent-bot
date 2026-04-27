import "server-only";

import {
  ToolLoopAgent,
  tool,
  type StepResult,
  type ToolSet,
} from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { serpTool } from "@/lib/tools/serp";
import { defaultStopWhen } from "@/lib/guardrails";
import { DEFAULT_MODEL } from "@/lib/cost";

/**
 * System prompt for the keyword-researcher subagent.
 *
 * SERP-only research: we lean entirely on what currently ranks for a
 * topic, because (a) the unofficial Google Trends API is rate-limited
 * to death on serverless IPs, and (b) the actual SERP is a stronger
 * signal of intent and competitor angle than trend curves anyway.
 *
 * The subagent uses a "final-tool" pattern instead of `Output.object`
 * because Gemini's API rejects requests that combine function calling
 * with `responseMimeType: application/json`. The model calls
 * `submit_brief` (whose `inputSchema` is the brief schema) as its last
 * action — Zod validates the args automatically, and the run stops via
 * the `hasToolCall("submit_brief")` guardrail.
 */
export const KEYWORD_RESEARCHER_PROMPT = `You are an SEO keyword research specialist.

Your job: turn a single topic into a tight keyword brief that the content
generator can immediately act on. Your single source of truth is the
live SERP — you do not have access to search-volume data.

Workflow:
1. Call \`serp_analysis\` once with the seed topic. Use the supplied
   DuckDuckGo locale (\`hl\`) verbatim. Examine titles, snippets, and
   domains in the result.
2. Optionally call \`serp_analysis\` a second time on a refined query
   only if the first SERP looks generic or off-intent — for example,
   appending a year, an audience modifier ("for small business"), or
   a question form ("how to ..."). Never call the tool with the same
   query twice. Most topics only need one call.
3. Once you have enough information, call \`submit_brief\` exactly once
   with the structured brief object as your final action. This ends the
   run.

How to derive the primary keyword:
- Prefer phrases that recur as n-grams across at least 3 of the top-5
  result titles — those are proven SEO targets.
- Pick a 2-6 word phrase that reads like a natural search query.
- Avoid branded queries (containing a vendor/competitor name) unless
  the user explicitly asks for a competitor comparison.

How to extract supporting keywords from a SERP:
- Recurring noun phrases from titles ("small business", "free trial",
  "comparison", "2026").
- Entities and modifiers from snippets (features, prices, audiences).
- Drop stopwords and brand names unless they are the topic itself.
- Aim for 5-10 high-signal phrases.

Search intent rules:
- "how", "what", "why", "guide", "tutorial" → informational
- "best", "vs", "review", "comparison", "top N" → commercial
- "buy", "price", "discount", "free trial" → transactional
- A bare product or brand name → navigational

Top competitors:
- Use the actual returned title and url verbatim — do NOT paraphrase
  titles or invent urls.
- For each, write one sentence describing the angle: listicle vs deep
  dive vs vendor page vs how-to vs comparison.

Content gap (one sentence):
- What angle, audience, or depth is the top-5 missing that our article
  can credibly take?

Strict rules:
- Never call \`serp_analysis\` more than 2 times.
- The final action of the run MUST be a call to \`submit_brief\`. Do
  not produce free-form text after the SERP step — go straight to
  \`submit_brief\` with the populated object.`;

/**
 * Schema for the keyword research brief returned to the orchestrator.
 *
 * The orchestrator forwards this object verbatim to the content generator,
 * so every field has to be self-explanatory from the JSON alone.
 */
export const keywordResearchOutputSchema = z.object({
  primary_keyword: z
    .string()
    .min(2)
    .describe("The single keyword the article should rank for."),
  supporting_keywords: z
    .array(z.string().min(2))
    .min(3)
    .max(15)
    .describe("Secondary keywords to weave into headings and body."),
  search_intent: z
    .enum(["informational", "navigational", "commercial", "transactional"])
    .describe("Dominant search intent inferred from the SERP."),
  top_competitors: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        angle: z
          .string()
          .describe(
            "One-sentence summary of the distinctive angle this result takes.",
          ),
      }),
    )
    .max(5)
    .describe("Up to 5 highest-ranking results worth differentiating from."),
  content_gap: z
    .string()
    .min(10)
    .describe(
      "One sentence describing what the current top results miss and how our article will fill that gap.",
    ),
});

export type KeywordResearchResult = z.infer<typeof keywordResearchOutputSchema>;

/**
 * "Final-tool" used to receive the structured brief from the subagent.
 *
 * Why this instead of `Output.object()`: Gemini rejects requests that
 * mix function-calling tools with `responseMimeType: application/json`
 * ("Function calling with a response mime type ... is unsupported").
 * Pumping the structured payload through a tool's `inputSchema` keeps
 * Zod validation, runs entirely in the function-calling channel, and
 * makes the SDK's own `hasToolCall("submit_brief")` stop condition the
 * natural end-of-run signal.
 *
 * `execute` is an identity function — we recover the validated args
 * back out of `step.toolResults` after the run.
 */
const submitBriefTool = tool({
  description:
    "Submit the final keyword research brief. Call this exactly once " +
    "after the SERP analysis is complete — this ends the research step.",
  inputSchema: keywordResearchOutputSchema,
  execute: async (brief): Promise<KeywordResearchResult> => brief,
});

/**
 * Subagent that produces the keyword brief. Runs in its own context window:
 * it can spend up to 5 LLM steps and 15K tokens on research without bloating
 * the orchestrator's context. Most topics resolve in 1-2 SERP calls plus
 * the final `submit_brief`.
 */
export const keywordResearcherAgent = new ToolLoopAgent({
  id: "keyword-researcher",
  model: google(DEFAULT_MODEL),
  instructions: KEYWORD_RESEARCHER_PROMPT,
  tools: {
    serp_analysis: serpTool,
    submit_brief: submitBriefTool,
  },
  stopWhen: defaultStopWhen({
    maxSteps: 5,
    maxTokens: 15_000,
    finalTool: "submit_brief",
  }),
});

/**
 * Convert a Google-Trends-style locale (e.g. "en-US", "uk-UA") into the
 * DuckDuckGo HTML endpoint's `kl` parameter form ("us-en", "ua-uk").
 *
 * The orchestrator-side tool keeps the original `hl` contract so the
 * public interface didn't change when we ripped Trends out — the
 * conversion lives here in the subagent boundary instead.
 */
function toDdgLocale(hl: string): string {
  const [lang, region] = hl.split("-");
  if (!lang || !region) return "us-en";
  return `${region.toLowerCase()}-${lang.toLowerCase()}`;
}

/**
 * Optional context object the orchestrator can attach via
 * `experimental_context` so subagent steps roll up to the same task's
 * cost tracking. Intentionally a duck-typed shape so the three subagent
 * files don't have to import from each other.
 */
export interface SubagentContext {
  /**
   * Forward each subagent step to a parent-side handler. Used by the
   * orchestrator to write per-step rows into `agent_runs` so daily-budget
   * accounting stays accurate even when the subagent does the heavy work.
   */
  onSubagentStep?: (
    subagentId: string,
    step: StepResult<ToolSet>,
  ) => Promise<void> | void;
}

/**
 * Vercel AI SDK tool the orchestrator calls to delegate keyword research.
 *
 * The orchestrator sees a single `tool_call` / `tool_result` pair in its
 * own loop — the subagent's intermediate steps stay isolated, keeping the
 * orchestrator context lean.
 */
export const researchKeywordsSubagentTool = tool({
  description:
    "Delegate SERP-driven keyword research to the keyword-research " +
    "subagent. Call this exactly once at the start of a task. Returns a " +
    "structured brief with the primary keyword, supporting keywords, " +
    "search intent, top competitors, and the content gap to target.",
  inputSchema: z.object({
    topic: z
      .string()
      .min(2)
      .describe("The seed topic the user supplied for this task."),
    geo: z
      .string()
      .default("US")
      .describe(
        "ISO country code, e.g. 'US' or 'UA'. Used as the regional cue when " +
          "interpreting SERP results.",
      ),
    hl: z
      .string()
      .default("en-US")
      .describe(
        "UI language code in BCP-47 form, e.g. 'en-US' or 'uk-UA'. The " +
          "subagent converts this internally to DuckDuckGo's locale format.",
      ),
  }),
  execute: async (
    { topic, geo, hl },
    { abortSignal, experimental_context },
  ): Promise<KeywordResearchResult> => {
    const ctx = experimental_context as SubagentContext | undefined;
    const ddgLocale = toDdgLocale(hl);

    const result = await keywordResearcherAgent.generate({
      prompt:
        `Topic: ${topic}\n` +
        `Geo: ${geo}\n` +
        `DuckDuckGo locale (pass to serp_analysis as hl): ${ddgLocale}\n\n` +
        `Run the SERP analysis, then call submit_brief with the final brief.`,
      abortSignal,
      onStepFinish: ctx?.onSubagentStep
        ? (step) => ctx.onSubagentStep!("keyword-researcher", step)
        : undefined,
    });

    // Recover the validated brief from the most recent submit_brief
    // tool call. We scan in reverse so the latest call wins, in case
    // the model called the tool more than once before stopping.
    for (const step of [...result.steps].reverse()) {
      for (const r of step.toolResults) {
        if (r.toolName === "submit_brief" && "output" in r) {
          return r.output as KeywordResearchResult;
        }
      }
    }
    throw new Error(
      `keyword-researcher stopped without calling submit_brief ` +
        `(finishReason=${result.finishReason}, steps=${result.steps.length}).`,
    );
  },
});
