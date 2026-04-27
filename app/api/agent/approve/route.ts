import { NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/server";
import { publishToTelegram } from "@/lib/tools/telegram";
import { formatArticleForTelegram } from "@/lib/api/telegram-format";

/**
 * POST /api/agent/approve — human-in-the-loop publish endpoint.
 *
 * Request body (JSON):
 * ```
 * { taskId: uuid, chatId?: string, disableLinkPreview?: boolean }
 * ```
 *
 * Flow:
 *   1. Confirm the task is in `awaiting_approval`. Any other state is
 *      a 409 — we never publish a draft twice and we never publish a
 *      task that hasn't reached the human-approval gate.
 *   2. Read the most-recently-inserted `articles` row for the task
 *      (the orchestrator guarantees exactly one, but ordering by
 *      `published_at desc nulls first` is an extra safety net).
 *   3. Convert the markdown body to Telegram-safe HTML, append a tag
 *      line built from the article's keywords, and call
 *      `publishToTelegram`. Long bodies get auto-split inside the tool.
 *   4. On success: persist `telegram_message_id` (the FIRST chunk's
 *      id; that's the canonical "this article" anchor) and
 *      `published_at`, then flip the task to `published` and stamp
 *      `approved_at`.
 *   5. On Telegram failure: leave the task at `awaiting_approval` so
 *      the user can hit Approve again (publish is idempotent from the
 *      *user's* perspective — we don't double-write the article on
 *      retry because no DB writes happen until Telegram succeeds).
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const approveRequestSchema = z.object({
  taskId: z.string().uuid(),
  chatId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Override TELEGRAM_CHANNEL_ID for this single publish (e.g. for a test channel).",
    ),
  disableLinkPreview: z.boolean().default(false),
});

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = approveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { taskId, chatId, disableLinkPreview } = parsed.data;
  const supabase = createAdminClient();

  // ---- 1. Verify the task is ready ---------------------------------
  const { data: taskRaw, error: taskErr } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("id", taskId)
    .single();
  if (taskErr || !taskRaw) {
    return Response.json(
      { error: `Task not found: ${taskErr?.message ?? taskId}` },
      { status: 404 },
    );
  }
  const task = taskRaw as { id: string; status: string };
  if (task.status !== "awaiting_approval") {
    return Response.json(
      {
        error: `Task is in '${task.status}'; only 'awaiting_approval' can be published.`,
      },
      { status: 409 },
    );
  }

  // ---- 2. Locate the article ---------------------------------------
  const { data: articleRaw, error: articleErr } = await supabase
    .from("articles")
    .select("id, title, content_md, keywords, published_at")
    .eq("task_id", taskId)
    .order("published_at", { ascending: false, nullsFirst: true })
    .limit(1)
    .single();
  if (articleErr || !articleRaw) {
    return Response.json(
      { error: `Article not found for task: ${articleErr?.message ?? taskId}` },
      { status: 404 },
    );
  }
  const article = articleRaw as {
    id: string;
    title: string;
    content_md: string;
    keywords: string[] | null;
    published_at: string | null;
  };
  if (article.published_at) {
    return Response.json(
      {
        error: `Article was already published at ${article.published_at}.`,
      },
      { status: 409 },
    );
  }

  // ---- 3. Publish to Telegram --------------------------------------
  const telegramText = formatArticleForTelegram(
    article.content_md,
    article.keywords ?? [],
  );

  let publishResult;
  try {
    publishResult = await publishToTelegram({
      text: telegramText,
      chatId,
      parseMode: "HTML",
      disableLinkPreview,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Telegram publish failed: ${message}` },
      { status: 502 },
    );
  }

  // ---- 4. Record the publication -----------------------------------
  // Telegram only — no canonical web URL — so we keep the FIRST chunk's
  // message id as the anchor; downstream tooling (analytics, edits) can
  // walk the consecutive ids if it ever needs the rest.
  const firstMessageId = publishResult.messageIds[0];
  const publishedAt = new Date().toISOString();

  const { error: articleUpdateErr } = await supabase
    .from("articles")
    .update({
      telegram_message_id: firstMessageId ?? null,
      published_at: publishedAt,
    })
    .eq("id", article.id);
  if (articleUpdateErr) {
    return Response.json(
      {
        error:
          "Article was sent to Telegram but the DB update failed: " +
          articleUpdateErr.message,
        telegram: publishResult,
      },
      { status: 500 },
    );
  }

  const { error: taskUpdateErr } = await supabase
    .from("tasks")
    .update({ status: "published", approved_at: publishedAt })
    .eq("id", taskId);
  if (taskUpdateErr) {
    return Response.json(
      {
        error:
          "Article published & saved but the task status update failed: " +
          taskUpdateErr.message,
        telegram: publishResult,
      },
      { status: 500 },
    );
  }

  return Response.json({
    taskId,
    articleId: article.id,
    title: article.title,
    publishedAt,
    chatId: publishResult.chatId,
    messageIds: publishResult.messageIds,
  });
}
