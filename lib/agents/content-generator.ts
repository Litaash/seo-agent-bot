import "server-only";

import { ToolLoopAgent, tool } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

import { serpTool } from "@/lib/tools/serp";
import { defaultStopWhen } from "@/lib/guardrails";
import { DEFAULT_MODEL } from "@/lib/cost";

import {
  keywordResearchOutputSchema,
  type KeywordResearchResult,
  type SubagentContext,
} from "@/lib/agents/keyword-researcher";

/**
 * System prompt for the content-generator subagent.
 *
 * Length, structure, and SEO formatting rules are enforced here so the
 * orchestrator doesn't need to re-spell them on every call.
 *
 * Like the keyword researcher, this subagent uses a "final-tool" pattern
 * (`submit_draft`) instead of `Output.object()` because Gemini rejects
 * requests that combine function calling with structured response MIME.
 */
export const CONTENT_GENERATOR_PROMPT = `You are an SEO content writer.

You will be given a structured keyword research brief plus a target output
language. Produce a single article that ranks for the primary keyword.

Hard requirements:
- 700-1100 words total. Articles outside this range will be rejected.
- Markdown body only — never include a YAML/TOML frontmatter block.
- Exactly one H1 (#) at the top. The H1 IS the article title.
- 3-5 H2 sections (##), each with 2-4 short paragraphs.
- A final ## section titled "Key takeaways" or its language-localized
  equivalent, with 3-5 bullet points.
- Use the primary keyword in the H1 and at least once in the first 100
  words. Weave supporting keywords naturally into H2s and body — never
  keyword-stuff.
- Ground concrete claims (statistics, prices, version numbers, dates) in
  the SERP results. If the top results don't support a claim, omit it.
- Write in the requested target language. Translate the headings; do
  NOT keep them in English when another language is requested.
- No fluff intros ("In this article we will explore..."). Open with a
  concrete hook tied to the search intent.

Tools:
- You may call \`serp_analysis\` up to 2 times if you need to verify a
  specific claim or find a competitor angle the brief did not cover.
- Do not call \`serp_analysis\` more than twice. Do not call it with the
  same query twice. Most articles need zero tool calls.
- Your single final action is a call to \`submit_draft\` with the
  finished article. This ends the run.

CRITICAL output rules — read carefully:
- NEVER write the article body as plain assistant text. The full
  Markdown body MUST live inside the \`content_md\` parameter of
  \`submit_draft\`. Plain text output of the article will be discarded.
- Do not produce a "draft preview" message before calling the tool. Go
  straight from any optional SERP step to \`submit_draft\`.
- The \`title\` field passed to \`submit_draft\` must match the article's
  H1 verbatim (without the leading "# ").
- Keep \`meta_description\` between 50 and 160 characters and include
  the primary keyword.`;

/**
 * Schema for the article draft. The orchestrator persists this directly
 * into the `articles` table, so the field names align with column names.
 */
export const articleDraftOutputSchema = z.object({
  title: z
    .string()
    .min(10)
    .max(120)
    .describe(
      "Article title without leading '# '. Must match the H1 in content_md.",
    ),
  content_md: z
    .string()
    .min(500)
    .describe(
      "Full Markdown body including the H1, H2 sections, and bullet takeaways.",
    ),
  keywords: z
    .array(z.string().min(2))
    .min(3)
    .max(15)
    .describe(
      "Primary + supporting keywords actually woven into the article. " +
        "Used for the articles.keywords text[] column and SERP debugging.",
    ),
  meta_description: z
    .string()
    .min(50)
    .max(160)
    .describe(
      "120-160 char SEO meta description. Includes the primary keyword.",
    ),
});

export type ArticleDraft = z.infer<typeof articleDraftOutputSchema>;

/**
 * Final-tool used to receive the finished article. See the same pattern
 * in `keyword-researcher.ts` — Gemini's API rejects combining tools with
 * `responseMimeType: application/json`, so we route the structured
 * payload through a tool's `inputSchema` for free Zod validation.
 */
const submitDraftTool = tool({
  description:
    "Submit the finished article draft. Call this exactly once when the " +
    "article is ready — this ends the writing step.",
  inputSchema: articleDraftOutputSchema,
  execute: async (draft): Promise<ArticleDraft> => draft,
});

/**
 * Subagent that turns a keyword brief into a finished Markdown article.
 * Runs in its own context window — its tool calls and reasoning don't
 * leak into the orchestrator's history.
 */
export const contentGeneratorAgent = new ToolLoopAgent({
  id: "content-generator",
  model: google(DEFAULT_MODEL),
  instructions: CONTENT_GENERATOR_PROMPT,
  tools: {
    serp_analysis: serpTool,
    submit_draft: submitDraftTool,
  },
  // 8 steps gives the model headroom to retry submit_draft after a
  // schema-validation tool-error (Gemini sometimes oversteps the meta
  // description length on the first attempt).
  stopWhen: defaultStopWhen({
    maxSteps: 8,
    maxTokens: 25_000,
    finalTool: "submit_draft",
  }),
});

/**
 * Vercel AI SDK tool the orchestrator calls to delegate article writing.
 *
 * Takes the keyword brief as input so the subagent never has to re-do
 * research the keyword agent already paid for. The orchestrator should
 * pass through the brief returned by `research_keywords` verbatim.
 */
export const generateContentSubagentTool = tool({
  description:
    "Delegate article writing to the content-generator subagent. Pass the " +
    "keyword brief returned by research_keywords plus the target language. " +
    "Returns the final article (title, Markdown body, meta description, " +
    "and the keywords actually used).",
  inputSchema: z.object({
    brief: keywordResearchOutputSchema.describe(
      "The keyword research brief produced by the research_keywords tool.",
    ),
    language: z
      .string()
      .default("English")
      .describe(
        "Human-readable target language for the article (e.g. 'English', 'Ukrainian'). The model translates headings and body into this language.",
      ),
    voice: z
      .string()
      .optional()
      .describe(
        "Optional editorial voice override (e.g. 'practical and concrete', 'academic'). Defaults to a neutral, expert tone.",
      ),
  }),
  execute: async (
    { brief, language, voice },
    { abortSignal, experimental_context },
  ): Promise<ArticleDraft> => {
    const ctx = experimental_context as SubagentContext | undefined;

    const promptParts = [
      `Target language: ${language}`,
      voice ? `Editorial voice: ${voice}` : null,
      "",
      "Keyword research brief (JSON):",
      "```json",
      JSON.stringify(brief satisfies KeywordResearchResult, null, 2),
      "```",
      "",
      "Call submit_draft with the finished article. The full Markdown body must live inside the content_md parameter — never as plain assistant text.",
    ].filter(Boolean) as string[];

    const result = await contentGeneratorAgent.generate({
      prompt: promptParts.join("\n"),
      abortSignal,
      onStepFinish: ctx?.onSubagentStep
        ? (step) => ctx.onSubagentStep!("content-generator", step)
        : undefined,
    });

    // Recover the validated draft from the most recent submit_draft
    // tool call. We scan in reverse so the latest call wins.
    for (const step of [...result.steps].reverse()) {
      for (const r of step.toolResults) {
        if (r.toolName === "submit_draft" && "output" in r) {
          return r.output as ArticleDraft;
        }
      }
    }

    // Fallback: Gemini sometimes streams the article as plain assistant
    // text instead of calling `submit_draft` (the longer the body, the
    // more likely it forgets the function call — especially in
    // non-English languages). If the final assistant message looks like
    // a real article, salvage it: build the structured draft ourselves
    // from the text + the brief and let the schema validate it.
    const finalText =
      typeof result.text === "string" ? result.text.trim() : "";
    if (finalText.length >= 500) {
      const synthesized = synthesizeDraftFromText(finalText, brief);
      const parsed = articleDraftOutputSchema.safeParse(synthesized);
      if (parsed.success) return parsed.data;
    }

    throw new Error(
      `content-generator stopped without calling submit_draft ` +
        `(finishReason=${result.finishReason}, steps=${result.steps.length}).`,
    );
  },
});

/**
 * Build an `ArticleDraft` from the model's free-form text output when it
 * forgot to call `submit_draft`. We extract the H1 as the title, use the
 * full text as `content_md`, and synthesize `keywords` + the
 * `meta_description` from the brief so all required fields are present.
 *
 * Best-effort: callers MUST validate the returned object against
 * `articleDraftOutputSchema` — if any field falls outside the allowed
 * range we'd rather fail the run than persist garbage.
 */
function synthesizeDraftFromText(
  text: string,
  brief: KeywordResearchResult,
): ArticleDraft {
  const h1Match = text.match(/^#\s+(.+?)\s*$/m);
  const titleRaw = (h1Match?.[1] ?? brief.primary_keyword).trim();
  const title =
    titleRaw.length > 120
      ? `${titleRaw.slice(0, 117).trimEnd()}...`
      : titleRaw.length < 10
        ? `${titleRaw} — 2026 guide`.slice(0, 120)
        : titleRaw;

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const k of [brief.primary_keyword, ...brief.supporting_keywords]) {
    const trimmed = k.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length >= 2 && !seen.has(key)) {
      seen.add(key);
      keywords.push(trimmed);
      if (keywords.length >= 12) break;
    }
  }

  // First non-heading paragraph — strip Markdown formatting marks so the
  // SERP-style preview reads as plain prose.
  const afterH1 = text.replace(/^#[^\n]*\n+/, "").trim();
  const firstParagraph =
    afterH1
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("-")) ?? "";
  const stripped = firstParagraph.replace(/[*_`]/g, "").replace(/\s+/g, " ");
  let metaDescription = stripped.slice(0, 160).trim();
  if (metaDescription.length < 50) {
    metaDescription = `${title}. ${brief.content_gap}`
      .replace(/\s+/g, " ")
      .slice(0, 160)
      .trim();
  }
  if (metaDescription.length < 50) {
    metaDescription =
      `${brief.primary_keyword} — practical guide for 2026 covering ` +
      `features, pricing, and selection criteria.`.slice(0, 160);
  }

  return {
    title,
    content_md: text,
    keywords,
    meta_description: metaDescription,
  };
}
