import Link from "next/link";
import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/server";
import {
  LiveTaskView,
  type InitialArticle,
  type InitialStep,
  type InitialTask,
} from "@/components/dashboard/live-task-view";
import { formatCostUsd, formatRelativeTime } from "@/lib/format";

/**
 * Task detail — live trace + article preview + Approve.
 *
 * The page is a Server Component that hydrates the initial state from
 * Supabase (no auth required because the dashboard runs single-owner
 * via the service-role key on the server). The interactive surface
 * lives in `LiveTaskView`, which subscribes to the SSE replay endpoint
 * and renders the Approve button when the task hits
 * `awaiting_approval`.
 *
 * We deliberately render every step the DB already has, so a refresh
 * mid-run never loses context — the SSE re-attachment then continues
 * from the last seen step.
 */
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ id: string }>;
}

interface TaskRowDb {
  id: string;
  topic: string;
  status: string;
  cost_usd: number | string | null;
  created_at: string;
  approved_at: string | null;
}

interface ArticleRowDb {
  id: string;
  title: string;
  content_md: string;
  keywords: string[] | null;
  published_at: string | null;
  telegram_message_id: number | string | null;
}

interface StepRowDb {
  id: string;
  step_type: string | null;
  content: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | string | null;
  created_at: string;
}

export default async function TaskDetailPage({ params }: PageProps) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = createAdminClient();

  const [taskRes, articleRes, stepsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, topic, status, cost_usd, created_at, approved_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("articles")
      .select(
        "id, title, content_md, keywords, published_at, telegram_message_id",
      )
      .eq("task_id", id)
      .order("published_at", { ascending: false, nullsFirst: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("agent_steps")
      .select(
        "id, step_type, content, tokens_in, tokens_out, cost_usd, created_at",
      )
      .eq("task_id", id)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  if (taskRes.error || !taskRes.data) {
    if (taskRes.error) {
      throw new Error(`Failed to load task: ${taskRes.error.message}`);
    }
    notFound();
  }

  const taskRow = taskRes.data as TaskRowDb;
  const articleRow = (articleRes.data ?? null) as ArticleRowDb | null;
  const stepsRows = (stepsRes.data ?? []) as StepRowDb[];

  const initialTask: InitialTask = {
    id: taskRow.id,
    topic: taskRow.topic,
    status: taskRow.status,
    costUsd: Number(taskRow.cost_usd ?? 0),
    createdAt: taskRow.created_at,
    approvedAt: taskRow.approved_at,
  };

  const initialArticle: InitialArticle | null = articleRow
    ? {
        id: articleRow.id,
        title: articleRow.title,
        content_md: articleRow.content_md,
        keywords: articleRow.keywords ?? [],
        publishedAt: articleRow.published_at,
        telegramMessageId:
          articleRow.telegram_message_id == null
            ? null
            : Number(articleRow.telegram_message_id),
      }
    : null;

  const initialSteps: InitialStep[] = stepsRows.map((row) => ({
    id: row.id,
    step_type: row.step_type,
    content: row.content,
    tokens_in: Number(row.tokens_in ?? 0),
    tokens_out: Number(row.tokens_out ?? 0),
    cost_usd: Number(row.cost_usd ?? 0),
    created_at: row.created_at,
  }));

  // We only attach the SSE stream for non-published tasks. A published
  // task's stream would be a no-op (all steps already drained) but the
  // open EventSource would still hold a long-lived poll connection.
  const liveAttach = taskRow.status !== "published";

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          ← All tasks
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold leading-tight tracking-tight">
          {taskRow.topic}
        </h1>
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Field label="Created">
            {formatRelativeTime(taskRow.created_at)}
          </Field>
          <Field label="Cost">
            {formatCostUsd(taskRow.cost_usd)}
          </Field>
          {taskRow.approved_at && (
            <Field label="Approved">
              {formatRelativeTime(taskRow.approved_at)}
            </Field>
          )}
          <Field label="Task id">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
              {taskRow.id.slice(0, 16)}…
            </code>
          </Field>
        </dl>
      </header>

      <LiveTaskView
        initialTask={initialTask}
        initialArticle={initialArticle}
        initialSteps={initialSteps}
        liveAttach={liveAttach}
      />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-muted-foreground/80">{label}:</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
