import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/server";
import { queryGsc } from "@/lib/tools/gsc";

/**
 * GET /api/cron/weekly-check — re-evaluate published articles against
 * Search Console once a week and queue re-optimisations for laggards.
 *
 * Triggered by Vercel Cron (`vercel.json` schedule "0 9 * * 1"). Vercel
 * sends `Authorization: Bearer ${CRON_SECRET}` so the same handler can
 * also be invoked manually with that header for ad-hoc debugging.
 *
 * Algorithm (one pass per article):
 *   1. Pull every article that's been published > 7 days ago AND was
 *      either never checked or last checked > 7 days ago.
 *   2. For each, query GSC (filtered on the article's primary keyword,
 *      grouped by query+page) for the last 28 days.
 *   3. Take the strongest-ranked row, persist its position / clicks /
 *      impressions / `last_checked_at` onto the `articles` row.
 *   4. If `gsc_position > 20`, spawn a `re-optimize: <title>` task so
 *      the orchestrator can have another go on the next manual run.
 *      We don't auto-trigger the run here — keeping HITL in place.
 *
 * The handler is fully deterministic (no LLM) so it's cheap and fast:
 * one GSC call per article. Rate-limited articles roll forward to the
 * next week's pass.
 */

// 5 minutes is plenty for a weekly batch — dozens of articles at most
// in MVP. Sequential GSC calls keep the per-article diagnostics simple.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface ArticleRow {
  id: string;
  task_id: string | null;
  title: string;
  keywords: string[] | null;
  published_at: string | null;
  last_checked_at: string | null;
}

interface PerArticleResult {
  articleId: string;
  title: string;
  status:
    | "evaluated"
    | "skipped_no_keyword"
    | "skipped_gsc_error"
    | "reoptimize_queued"
    | "skipped_reoptimize_exists";
  position?: number;
  clicks?: number;
  impressions?: number;
  message?: string;
  newTaskId?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REOPTIMIZE_POSITION_THRESHOLD = 20;

export async function GET(request: NextRequest): Promise<Response> {
  // ---- 1. Auth -----------------------------------------------------
  // Vercel Cron sends the secret as a Bearer token. Allow `?secret=`
  // too so the endpoint is callable from a browser during local dev.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    const fromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const fromQuery = request.nextUrl.searchParams.get("secret");
    if (fromHeader !== secret && fromQuery !== secret) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  // ---- 2. Optional GSC site URL ------------------------------------
  // No site URL configured → cron is a no-op rather than a crash. Lets
  // the project run end-to-end (ship articles, approve them) without
  // requiring Search Console credentials in dev.
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) {
    return Response.json({
      ok: true,
      skipped: "GSC_SITE_URL not configured.",
      evaluated: 0,
      reoptimised: 0,
      results: [],
    });
  }

  const supabase = createAdminClient();

  // ---- 3. Fetch eligible articles ----------------------------------
  const cutoffIso = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const { data: rawArticles, error: articlesErr } = await supabase
    .from("articles")
    .select("id, task_id, title, keywords, published_at, last_checked_at")
    .not("published_at", "is", null)
    .lt("published_at", cutoffIso)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoffIso}`)
    .order("published_at", { ascending: true })
    .limit(50);

  if (articlesErr) {
    return Response.json(
      { error: `Failed to read articles: ${articlesErr.message}` },
      { status: 500 },
    );
  }

  const articles = (rawArticles ?? []) as ArticleRow[];
  const results: PerArticleResult[] = [];

  // ---- 4. Per-article evaluation -----------------------------------
  for (const article of articles) {
    const primaryKeyword = article.keywords?.[0]?.trim();
    if (!primaryKeyword) {
      results.push({
        articleId: article.id,
        title: article.title,
        status: "skipped_no_keyword",
        message: "Article has no keywords; cannot identify a GSC query.",
      });
      continue;
    }

    let position = 0;
    let clicks = 0;
    let impressions = 0;

    try {
      // Filter on the article's primary keyword and let GSC return up
      // to a few rows per page+query pair. We pick the row with the
      // most impressions as the canonical "this article's" performance.
      const gsc = await queryGsc({
        siteUrl,
        query: primaryKeyword,
        dimensions: ["query", "page"],
        rowLimit: 25,
      });
      if (gsc.rows.length === 0) {
        // No impressions yet — record the check so we don't retry on
        // every cron tick, but otherwise leave the article alone.
        await supabase
          .from("articles")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("id", article.id);
        results.push({
          articleId: article.id,
          title: article.title,
          status: "evaluated",
          position: 0,
          clicks: 0,
          impressions: 0,
          message: "No GSC rows for the primary keyword yet.",
        });
        continue;
      }

      const best = [...gsc.rows].sort(
        (a, b) => b.impressions - a.impressions,
      )[0];
      position = best.position;
      clicks = best.clicks;
      impressions = best.impressions;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        articleId: article.id,
        title: article.title,
        status: "skipped_gsc_error",
        message,
      });
      continue;
    }

    // Persist whatever we measured before deciding whether to queue a
    // re-optimisation. That way a crash later in the loop doesn't lose
    // the GSC numbers for this article.
    const { error: updateErr } = await supabase
      .from("articles")
      .update({
        gsc_position: position || null,
        gsc_clicks: clicks,
        gsc_impressions: impressions,
        last_checked_at: new Date().toISOString(),
      })
      .eq("id", article.id);
    if (updateErr) {
      results.push({
        articleId: article.id,
        title: article.title,
        status: "skipped_gsc_error",
        message: `articles update failed: ${updateErr.message}`,
        position,
        clicks,
        impressions,
      });
      continue;
    }

    if (position > REOPTIMIZE_POSITION_THRESHOLD) {
      // De-dupe: if a re-optimize task for this article is already
      // open, don't pile another one on. Cheap text match — scale
      // pressure here is at most ~50 articles per cron run.
      const reoptimizeTopic = `re-optimize: ${article.title}`;
      const { data: existing } = await supabase
        .from("tasks")
        .select("id")
        .eq("topic", reoptimizeTopic)
        .in("status", ["pending", "running", "awaiting_approval"])
        .limit(1)
        .maybeSingle();

      if (existing) {
        results.push({
          articleId: article.id,
          title: article.title,
          status: "skipped_reoptimize_exists",
          position,
          clicks,
          impressions,
        });
        continue;
      }

      const { data: newTask, error: newTaskErr } = await supabase
        .from("tasks")
        .insert({ topic: reoptimizeTopic, status: "pending" })
        .select("id")
        .single();

      if (newTaskErr || !newTask) {
        results.push({
          articleId: article.id,
          title: article.title,
          status: "skipped_gsc_error",
          message: `Failed to queue re-optimize task: ${newTaskErr?.message ?? "unknown"}`,
          position,
          clicks,
          impressions,
        });
        continue;
      }

      results.push({
        articleId: article.id,
        title: article.title,
        status: "reoptimize_queued",
        position,
        clicks,
        impressions,
        newTaskId: (newTask as { id: string }).id,
      });
    } else {
      results.push({
        articleId: article.id,
        title: article.title,
        status: "evaluated",
        position,
        clicks,
        impressions,
      });
    }
  }

  return Response.json({
    ok: true,
    evaluated: results.length,
    reoptimised: results.filter((r) => r.status === "reoptimize_queued").length,
    cutoff: cutoffIso,
    results,
  });
}
