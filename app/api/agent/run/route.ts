import { NextRequest } from "next/server";
import { z } from "zod";

import { runOrchestrator } from "@/lib/agents/orchestrator";
import { createAdminClient } from "@/lib/supabase/server";
import { createTaskStream, SSE_HEADERS } from "@/lib/api/sse";
import {
  DailyBudgetExceededError,
  RunTimeoutError,
} from "@/lib/guardrails";

/**
 * POST /api/agent/run — kick off a new SEO agent run and stream its
 * progress over Server-Sent Events.
 *
 * Request body (JSON):
 * ```
 * { topic, geo?, hl?, language?, voice? }
 * ```
 *
 * Response: `text/event-stream` with the frame schema documented in
 * `lib/api/sse.ts`. The first frame is `task_status` carrying the new
 * task id; the dashboard's POST handler reads that, navigates to
 * `/tasks/[id]`, and re-attaches via `GET /api/tasks/[id]/stream` on
 * page reload.
 */

// Vercel Hobby caps Serverless Functions at 300s. The orchestrator's
// own `RUN_TIMEOUT_MS` is set to 4 minutes so our `AbortSignal` fires
// ~60s before the platform kill — that buffer lets the SSE stream
// flush a final `done` / `error` frame after the agent settles.
export const maxDuration = 300;

export const dynamic = "force-dynamic";

const runRequestSchema = z.object({
  topic: z.string().min(2).max(200),
  geo: z.string().min(2).max(8).optional(),
  hl: z.string().min(2).max(10).optional(),
  language: z.string().min(2).max(40).optional(),
  voice: z.string().max(80).optional(),
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

  const parsed = runRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Insert the parent task row up-front so the orchestrator (and the
  // SSE stream) have a stable id to attach steps to. Status starts as
  // 'pending'; the orchestrator flips it to 'running' on first action.
  const { data: task, error: insertErr } = await supabase
    .from("tasks")
    .insert({ topic: parsed.data.topic, status: "pending" })
    .select("id")
    .single();

  if (insertErr || !task) {
    return Response.json(
      {
        error: `Failed to create task row: ${insertErr?.message ?? "unknown error"}`,
      },
      { status: 500 },
    );
  }

  const taskId = (task as { id: string }).id;

  // Kick off the orchestrator. We deliberately do NOT await: the SSE
  // stream needs to start emitting frames immediately, and the run
  // promise is handed to `createTaskStream` so the stream can emit its
  // own `done` / `error` frame from the same Promise's resolution.
  // The orchestrator itself owns the 5-minute hard timeout.
  const runPromise = runOrchestrator({
    taskId,
    topic: parsed.data.topic,
    geo: parsed.data.geo,
    hl: parsed.data.hl,
    language: parsed.data.language,
    voice: parsed.data.voice,
  })
    .then((result) => ({ articleId: result.articleId, cost: result.cost }))
    .catch((err: unknown) => {
      // Translate guardrail errors into a richer payload so the UI can
      // distinguish "you ran out of budget" from "the agent crashed".
      if (err instanceof DailyBudgetExceededError) {
        throw new Error(
          `Daily LLM budget exceeded: $${err.spentUsd.toFixed(4)} / $${err.limitUsd.toFixed(2)}.`,
        );
      }
      if (err instanceof RunTimeoutError) {
        throw new Error(
          `Run timed out after ${Math.round(err.timeoutMs / 1000)}s.`,
        );
      }
      throw err;
    });

  // Prevent an unhandled-rejection log spam if the SSE consumer
  // disconnects before the promise settles. `createTaskStream` attaches
  // its own `.then`/`.catch` for the wire frames; this handler only
  // exists to keep Node happy when the stream gets cancelled.
  runPromise.catch(() => undefined);

  const stream = createTaskStream(taskId, { runPromise });
  return new Response(stream, { headers: SSE_HEADERS });
}
