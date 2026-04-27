import "server-only";

import { createAdminClient } from "@/lib/supabase/server";

/**
 * Server-Sent Events helpers for the live task stream.
 *
 * The agent UX has two streaming consumers:
 *
 *   1. `POST /api/agent/run` — kicks off the orchestrator and streams
 *      step events as they're written to `agent_steps` so the user sees
 *      the agent thinking in real time.
 *   2. `GET  /api/tasks/[id]/stream` — same stream, replayed from row 0
 *      so a user who refreshes the page mid-run can resume watching.
 *
 * Both endpoints share the same wire format (the events below) so the
 * dashboard can use a single `EventSource` abstraction.
 */

/**
 * The set of `event:` names this module emits. Keeping them as a const
 * union here means the dashboard's `EventSource` switch is exhaustive.
 */
export type TaskStreamEvent =
  /** Sent once at stream open with the task row's current status snapshot. */
  | "task_status"
  /** One row from `agent_steps`. The data payload mirrors that row. */
  | "step"
  /** Cost / step-count delta after a step. Cheaper than re-querying. */
  | "task_meta"
  /** Run finished successfully; client can navigate to the article preview. */
  | "done"
  /** Run failed; data carries `{ message }`. */
  | "error"
  /** Periodic keep-alive comment so proxies don't close the connection. */
  | "ping";

export interface SseFrame {
  event: TaskStreamEvent;
  data: unknown;
  /** Optional Last-Event-ID; we use the row's UUID where applicable. */
  id?: string;
}

/**
 * Standard SSE response headers. Disabling caching + buffering is
 * critical: behind a CDN/proxy, even a few seconds of buffering would
 * make the live UI feel broken.
 */
export const SSE_HEADERS: HeadersInit = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, must-revalidate, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

/** Encode an SSE frame to the wire format. */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  // JSON-encoded payload. Multi-line payloads are valid SSE only when each
  // line is `data:`-prefixed, but JSON.stringify never emits literal '\n'
  // unless the original data contained one — and we don't need to; we
  // just fold the whole payload onto one `data:` line.
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return lines.join("\n") + "\n\n";
}

/** Encode a comment-only keep-alive frame. */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** Terminal task statuses — once seen, the stream can close cleanly. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "published",
  "failed",
]);

interface AgentStepRow {
  id: string;
  task_id: string;
  step_type: string | null;
  content: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  status: string;
  cost_usd: number | null;
}

export interface TaskStreamOptions {
  /** Poll interval in ms. Default 600ms — fast enough to feel live, low write load. */
  pollIntervalMs?: number;
  /** Send a `: ping` comment every N ms to keep proxies open. Default 15s. */
  pingIntervalMs?: number;
  /**
   * Hard ceiling on how long the stream stays open even if the task
   * never reaches a terminal status. Default 6 minutes — a safety net
   * matching the orchestrator's 5-minute run timeout plus headroom.
   */
  maxOpenMs?: number;
  /**
   * Optional promise the run-route awaits. When this settles we emit
   * `done` (resolve) or `error` (reject) and close the stream regardless
   * of whether the DB has been polled yet.
   */
  runPromise?: Promise<{ articleId: string; cost: unknown }>;
}

/**
 * Build a `ReadableStream` that emits SSE frames for the lifetime of a
 * task. Stops automatically when:
 *   - The task hits a terminal status (`awaiting_approval`, `published`,
 *     `failed`) AND we've drained all known steps.
 *   - `runPromise` resolves/rejects.
 *   - The client disconnects (we observe `signal.aborted`).
 *   - `maxOpenMs` elapses.
 *
 * The polling approach (vs Supabase Realtime) is intentional: it keeps
 * the dependency surface small and works on every Vercel runtime
 * without extra config. With ~6 events per typical run and a 600ms
 * poll, the read overhead is in the tens of queries — negligible.
 */
export function createTaskStream(
  taskId: string,
  options: TaskStreamOptions = {},
): ReadableStream<Uint8Array> {
  const {
    pollIntervalMs = 600,
    pingIntervalMs = 15_000,
    maxOpenMs = 6 * 60 * 1000,
    runPromise,
  } = options;

  const encoder = new TextEncoder();
  const supabase = createAdminClient();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSeenIso: string | null = null;
      const seenStepIds = new Set<string>();
      const startedAt = Date.now();

      const send = (frame: SseFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSseFrame(frame)));
        } catch {
          // Controller already closed (client disconnect) — flip the
          // flag so the polling loop exits on the next tick.
          closed = true;
        }
      };

      const sendComment = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSseComment(text)));
        } catch {
          closed = true;
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed — nothing to do.
        }
      };

      // Periodic keep-alive comments. Browsers + CDNs both treat 15s
      // of silence as "probably dead"; comments are valid SSE noise.
      const pingTimer = setInterval(() => {
        if (closed) {
          clearInterval(pingTimer);
          return;
        }
        sendComment(`ping ${Date.now()}`);
      }, pingIntervalMs);

      // ---- 1. Open with the current task snapshot --------------------
      const { data: initialTaskRaw, error: initialErr } = await supabase
        .from("tasks")
        .select("id, status, cost_usd")
        .eq("id", taskId)
        .single();
      const initialTask = initialTaskRaw as TaskRow | null;

      if (initialErr) {
        send({
          event: "error",
          data: { message: `Failed to read task: ${initialErr.message}` },
        });
        clearInterval(pingTimer);
        finish();
        return;
      }

      send({
        event: "task_status",
        data: {
          taskId,
          status: initialTask?.status ?? "unknown",
          costUsd: Number(initialTask?.cost_usd ?? 0),
        },
      });

      // ---- 2. Bridge the run promise (if provided) -------------------
      // If the caller is `/api/agent/run`, it gives us the promise so we
      // can emit a single authoritative `done` / `error` frame from the
      // orchestrator's own resolution rather than inferring it from the
      // task row.
      if (runPromise) {
        runPromise
          .then((result) => {
            send({ event: "done", data: result });
            finish();
            clearInterval(pingTimer);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            send({ event: "error", data: { message } });
            finish();
            clearInterval(pingTimer);
          });
      }

      // ---- 3. Polling loop -------------------------------------------
      while (!closed) {
        if (Date.now() - startedAt >= maxOpenMs) {
          send({
            event: "error",
            data: { message: `Stream exceeded maxOpenMs (${maxOpenMs}ms)` },
          });
          break;
        }

        // Pull all step rows newer than the last one we sent. Using the
        // timestamp index is fast even on large tables; we de-dupe by
        // id to handle equal-timestamp rows from a single batch insert.
        let q = supabase
          .from("agent_steps")
          .select(
            "id, task_id, step_type, content, tokens_in, tokens_out, cost_usd, created_at",
          )
          .eq("task_id", taskId)
          .order("created_at", { ascending: true })
          .limit(200);

        if (lastSeenIso) {
          q = q.gte("created_at", lastSeenIso);
        }

        const { data: rows, error: rowsErr } = await q;
        if (rowsErr) {
          send({
            event: "error",
            data: { message: `Failed to read agent_steps: ${rowsErr.message}` },
          });
          break;
        }

        for (const row of (rows ?? []) as AgentStepRow[]) {
          if (seenStepIds.has(row.id)) continue;
          seenStepIds.add(row.id);
          lastSeenIso = row.created_at;
          send({ event: "step", id: row.id, data: row });
        }

        // Refresh the task status — it may have flipped to a terminal
        // state by another writer (the orchestrator's catch block, or
        // the approve route).
        const { data: taskRaw, error: taskErr } = await supabase
          .from("tasks")
          .select("id, status, cost_usd")
          .eq("id", taskId)
          .single();
        const task = taskRaw as TaskRow | null;

        if (taskErr) {
          send({
            event: "error",
            data: { message: `Failed to refresh task: ${taskErr.message}` },
          });
          break;
        }

        if (task) {
          send({
            event: "task_meta",
            data: {
              status: task.status,
              costUsd: Number(task.cost_usd ?? 0),
            },
          });

          // If we don't have a run promise driving us and the task is
          // terminal, we close as soon as we've drained the latest steps.
          if (!runPromise && TERMINAL_STATUSES.has(task.status)) {
            send({
              event: "done",
              data: { taskId, status: task.status },
            });
            break;
          }
        }

        await sleep(pollIntervalMs);
      }

      clearInterval(pingTimer);
      finish();
    },

    cancel() {
      // Client closed the connection. The `start` loop checks `closed`
      // each tick via the controller, but we also want any in-flight
      // sleep to wake quickly — controlled by `pollIntervalMs`.
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
