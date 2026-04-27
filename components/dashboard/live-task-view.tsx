"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { TaskStatusBadge } from "@/components/dashboard/task-status-badge";
import { formatCostUsd, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Client-side renderer for `/tasks/[id]`.
 *
 * Wires three things together:
 *   1. A live `EventSource` subscription to `/api/tasks/[id]/stream`.
 *      The same stream is used by `POST /api/agent/run` mid-flight and
 *      by replay-after-reload, so the UI logic doesn't care which is
 *      driving it.
 *   2. A "Replay" button that reopens the EventSource — useful when a
 *      proxy timed the connection out without the agent finishing.
 *   3. The Approve action, which only appears when the task hits
 *      `awaiting_approval`. It POSTs to `/api/agent/approve`, then
 *      `router.refresh()` so the server-rendered article preview picks
 *      up the new `published_at` + `telegram_message_id`.
 */

export interface InitialTask {
  id: string;
  topic: string;
  status: string;
  costUsd: number;
  createdAt: string;
  approvedAt: string | null;
}

export interface InitialArticle {
  id: string;
  title: string;
  content_md: string;
  keywords: string[];
  publishedAt: string | null;
  telegramMessageId: number | null;
}

export interface InitialStep {
  id: string;
  step_type: string | null;
  content: unknown;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_at: string;
}

export interface LiveTaskViewProps {
  initialTask: InitialTask;
  initialArticle: InitialArticle | null;
  initialSteps: InitialStep[];
  /**
   * If true, the client opens an SSE subscription to listen for new
   * steps. Set to false for definitively-terminal tasks where there's
   * no orchestrator left to listen to (e.g. published).
   */
  liveAttach: boolean;
}

interface StepView extends InitialStep {
  index: number;
}

const TERMINAL_STATUSES = new Set([
  "awaiting_approval",
  "published",
  "failed",
]);

export function LiveTaskView(props: LiveTaskViewProps) {
  const router = useRouter();
  const [status, setStatus] = React.useState(props.initialTask.status);
  const [costUsd, setCostUsd] = React.useState(props.initialTask.costUsd);
  const [steps, setSteps] = React.useState<StepView[]>(() =>
    props.initialSteps.map((s, i) => ({ ...s, index: i + 1 })),
  );
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [streamGen, setStreamGen] = React.useState(0);
  const seenIdsRef = React.useRef(new Set(steps.map((s) => s.id)));
  const stepCounterRef = React.useRef(steps.length);

  const shouldStream = props.liveAttach && !TERMINAL_STATUSES.has(status);

  React.useEffect(() => {
    if (!shouldStream && streamGen === 0) return;
    if (!shouldStream) return;
    const url = `/api/tasks/${encodeURIComponent(props.initialTask.id)}/stream`;
    const es = new EventSource(url);

    es.addEventListener("task_status", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status?: string;
          costUsd?: number;
        };
        if (typeof data.status === "string") setStatus(data.status);
        if (typeof data.costUsd === "number") setCostUsd(data.costUsd);
      } catch {
        // Ignore malformed frame; the polling loop will resend.
      }
    });

    es.addEventListener("task_meta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status?: string;
          costUsd?: number;
        };
        if (typeof data.status === "string") setStatus(data.status);
        if (typeof data.costUsd === "number") setCostUsd(data.costUsd);
      } catch {
        // Ignore malformed frame.
      }
    });

    es.addEventListener("step", (event) => {
      try {
        const row = JSON.parse((event as MessageEvent).data) as InitialStep;
        if (!row?.id || seenIdsRef.current.has(row.id)) return;
        seenIdsRef.current.add(row.id);
        stepCounterRef.current += 1;
        setSteps((prev) => [
          ...prev,
          { ...row, index: stepCounterRef.current },
        ]);
      } catch {
        // Bad payload: keep the connection.
      }
    });

    es.addEventListener("done", () => {
      es.close();
      router.refresh();
    });

    es.addEventListener("error", (event) => {
      // EventSource only fires generic `error` for transport issues; our
      // server-side `error` event also arrives here. Try to surface a
      // message either way.
      const message =
        (event as MessageEvent).data &&
        (() => {
          try {
            return (
              (JSON.parse((event as MessageEvent).data) as { message?: string })
                .message ?? null
            );
          } catch {
            return null;
          }
        })();
      if (message) setStreamError(message);
      // EventSource auto-reconnects on transport errors — only manually
      // close it if the server explicitly sent an error frame.
      if (message) {
        es.close();
      }
    });

    return () => {
      es.close();
    };
  }, [props.initialTask.id, shouldStream, streamGen, router]);

  // ---- approve action ---------------------------------------------------
  const [approving, setApproving] = React.useState(false);
  const [approveError, setApproveError] = React.useState<string | null>(null);

  const onApprove = async () => {
    if (approving) return;
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: props.initialTask.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Approve failed (HTTP ${res.status}).`);
      }
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApproveError(message);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      {/* ---- LEFT: live log ------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Live log
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
            {props.liveAttach && (
              <span
                className={cn(
                  "inline-flex h-1.5 w-1.5 rounded-full",
                  shouldStream
                    ? "bg-emerald-500 animate-pulse"
                    : "bg-muted-foreground/40",
                )}
                title={
                  shouldStream
                    ? "Receiving live events"
                    : TERMINAL_STATUSES.has(status)
                      ? "Run finished"
                      : "Stream closed"
                }
              />
            )}
            {!shouldStream && props.liveAttach && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setStreamError(null);
                  setStreamGen((g) => g + 1);
                }}
              >
                Replay
              </Button>
            )}
          </div>
        </header>

        <div className="rounded-xl border bg-card ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <TaskStatusBadge status={status} />
              <span className="text-muted-foreground">
                · {formatCostUsd(costUsd)}
              </span>
            </div>
            <div className="text-muted-foreground">
              created {formatRelativeTime(props.initialTask.createdAt)}
            </div>
          </div>
          <ol className="divide-y">
            {steps.length === 0 ? (
              <li className="p-6 text-sm text-muted-foreground">
                Waiting for the first step…
              </li>
            ) : (
              steps.map((step) => <StepRow key={step.id} step={step} />)
            )}
          </ol>
        </div>

        {streamError && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            Stream error: {streamError}
          </p>
        )}
      </section>

      {/* ---- RIGHT: article preview + approve ------------------------ */}
      <section className="flex flex-col gap-3">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Article
          </h2>
          {props.initialArticle?.publishedAt && (
            <span className="text-xs text-emerald-600 dark:text-emerald-300">
              Published {formatRelativeTime(props.initialArticle.publishedAt)}
            </span>
          )}
        </header>

        <ArticlePanel
          article={props.initialArticle}
          status={status}
          onApprove={onApprove}
          approving={approving}
          approveError={approveError}
        />
      </section>
    </div>
  );
}

function StepRow({ step }: { step: StepView }) {
  const summary = describeStep(step);
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground">
            {step.index}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
              stepTypeClass(step.step_type),
            )}
          >
            {step.step_type ?? "step"}
          </span>
          {summary.label && (
            <span className="text-muted-foreground/80">{summary.label}</span>
          )}
        </div>
        <span>{formatRelativeTime(step.created_at)}</span>
      </div>
      {summary.body && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground">
          {summary.body}
        </pre>
      )}
      {(step.tokens_in > 0 ||
        step.tokens_out > 0 ||
        Number(step.cost_usd) > 0) && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {step.tokens_in > 0 && <span>in: {step.tokens_in.toLocaleString()}</span>}
          {step.tokens_out > 0 && (
            <span>out: {step.tokens_out.toLocaleString()}</span>
          )}
          {Number(step.cost_usd) > 0 && (
            <span>{formatCostUsd(step.cost_usd)}</span>
          )}
        </div>
      )}
    </li>
  );
}

interface StepSummary {
  label?: string;
  body?: string;
}

function describeStep(step: StepView): StepSummary {
  const content = (step.content ?? {}) as Record<string, unknown>;
  switch (step.step_type) {
    case "tool_call": {
      const toolName = String(content.toolName ?? "tool");
      const input = content.input;
      return {
        label: `→ ${toolName}`,
        body: input ? safeStringify(input) : undefined,
      };
    }
    case "tool_result": {
      const toolName = String(content.toolName ?? "tool");
      const output = content.output;
      return {
        label: `← ${toolName}`,
        body: output ? safeStringify(output) : undefined,
      };
    }
    case "think": {
      const text = String(content.text ?? "");
      return { label: "thought", body: text || undefined };
    }
    case "content": {
      const text = String(content.text ?? "");
      return { body: text || undefined };
    }
    case "error": {
      return {
        label: "error",
        body: String(content.message ?? "unknown error"),
      };
    }
    default:
      return { body: safeStringify(content) };
  }
}

function safeStringify(value: unknown, maxLen = 1200): string {
  let str: string;
  try {
    str =
      typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  } catch {
    str = String(value);
  }
  if (str.length > maxLen) return str.slice(0, maxLen) + "\n…";
  return str;
}

function stepTypeClass(type: string | null): string {
  switch (type) {
    case "tool_call":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "tool_result":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "think":
      return "bg-purple-500/10 text-purple-700 dark:text-purple-300";
    case "content":
      return "bg-muted text-foreground";
    case "error":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-foreground";
  }
}

interface ArticlePanelProps {
  article: InitialArticle | null;
  status: string;
  onApprove: () => Promise<void>;
  approving: boolean;
  approveError: string | null;
}

function ArticlePanel({
  article,
  status,
  onApprove,
  approving,
  approveError,
}: ArticlePanelProps) {
  if (!article) {
    return (
      <div className="rounded-xl border border-dashed bg-card/50 p-6 text-sm text-muted-foreground">
        {status === "failed"
          ? "The run failed before producing a draft. Inspect the live log on the left for the cause."
          : "The article will appear here once the agent reaches save_draft."}
      </div>
    );
  }

  const canApprove = status === "awaiting_approval";

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-lg font-semibold leading-tight">
          {article.title}
        </h3>
        {article.keywords.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {article.keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
              >
                {kw}
              </span>
            ))}
          </div>
        )}
      </div>

      <article className="prose-sm whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {article.content_md}
      </article>

      {canApprove && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <Button
            type="button"
            onClick={onApprove}
            disabled={approving}
            className="w-full"
          >
            {approving ? "Publishing…" : "Approve & publish to Telegram"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Sends the article to <code>TELEGRAM_CHANNEL_ID</code> and marks
            the task as published. Long bodies auto-split across messages.
          </p>
          {approveError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {approveError}
            </p>
          )}
        </div>
      )}

      {article.publishedAt && article.telegramMessageId && (
        <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span>Telegram message id</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
            {article.telegramMessageId}
          </code>
        </div>
      )}
    </div>
  );
}
