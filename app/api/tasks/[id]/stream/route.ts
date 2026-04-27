import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/server";
import { createTaskStream, SSE_HEADERS } from "@/lib/api/sse";

/**
 * GET /api/tasks/[id]/stream — replay + live-tail the agent steps for
 * an existing task as Server-Sent Events.
 *
 * Used by the dashboard's `/tasks/[id]` page when the user reloads
 * mid-run, or simply opens an old task to see the trace. Unlike
 * `/api/agent/run`, this endpoint does NOT kick off the orchestrator —
 * it only reads from `agent_steps`. If the task is already terminal
 * (`awaiting_approval` / `published` / `failed`) the stream emits the
 * recorded steps in order and closes cleanly.
 *
 * Frame schema is documented in `lib/api/sse.ts` and matches what
 * `/api/agent/run` emits, so a single client-side EventSource
 * abstraction handles both.
 */

// Vercel Hobby caps Serverless Functions at 300s. The client reopens
// the EventSource via the Replay button if a long-running task hits
// the cutoff before the orchestrator finishes.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return Response.json(
      { error: "Task id must be a UUID." },
      { status: 400 },
    );
  }

  // Cheap pre-flight: 404 fast if the task doesn't exist so the
  // dashboard doesn't open a long-lived connection that would just
  // emit an `error` frame.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: `Failed to read task: ${error.message}` },
      { status: 500 },
    );
  }
  if (!data) {
    return Response.json({ error: `Task ${id} not found.` }, { status: 404 });
  }

  const stream = createTaskStream(id);
  return new Response(stream, { headers: SSE_HEADERS });
}
