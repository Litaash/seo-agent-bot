import Link from "next/link";

import { createAdminClient } from "@/lib/supabase/server";
import { NewTaskForm } from "@/components/dashboard/new-task-form";
import { TaskStatusBadge } from "@/components/dashboard/task-status-badge";
import {
  formatCostUsd,
  formatRelativeTime,
  truncate,
} from "@/lib/format";

/**
 * Dashboard index — the operator's "home base".
 *
 *   - The "New task" form kicks off `POST /api/agent/run` and (on the
 *     first SSE frame) navigates to `/tasks/[id]` for the live trace.
 *   - The list below shows the most recent runs with status, cost, and
 *     a click-through to the detail page. Awaiting-approval tasks are
 *     highlighted so the operator notices the HITL gate without a
 *     scroll.
 *
 * We rely on Server Components + the service-role client for DB reads
 * because there's no auth on the browser in MVP — the page is private
 * by virtue of being deployed under an unguessable URL.
 */
export const dynamic = "force-dynamic";

interface TaskListRow {
  id: string;
  topic: string;
  status: string;
  cost_usd: number | string | null;
  created_at: string;
  approved_at: string | null;
}

const LIST_LIMIT = 50;

async function loadTasks(): Promise<TaskListRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, topic, status, cost_usd, created_at, approved_at")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    throw new Error(`Failed to read tasks: ${error.message}`);
  }
  return (data ?? []) as TaskListRow[];
}

export default async function DashboardHomePage() {
  let tasks: TaskListRow[] = [];
  let loadError: string | null = null;
  try {
    tasks = await loadTasks();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const awaitingCount = tasks.filter(
    (t) => t.status === "awaiting_approval",
  ).length;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Tasks
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each task is one autonomous research → generate → save_draft cycle.
          Drafts pause at <code>awaiting_approval</code> until you publish
          them to Telegram.
          {awaitingCount > 0 && (
            <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">
              ({awaitingCount} draft{awaitingCount === 1 ? "" : "s"} waiting
              for approval.)
            </span>
          )}
        </p>
      </section>

      <NewTaskForm />

      {loadError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Could not load tasks: {loadError}
        </p>
      ) : tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <TaskList rows={tasks} />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card/40 p-10 text-center">
      <p className="font-medium">No runs yet</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Type a topic above and hit <em>Run agent</em>. The first cycle
        usually finishes in 1–3 minutes for about $0.03 of LLM spend.
      </p>
    </div>
  );
}

function TaskList({ rows }: { rows: TaskListRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Topic</span>
        <span>Status</span>
        <span className="justify-self-end">Cost</span>
        <span className="justify-self-end">Created</span>
      </div>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/tasks/${row.id}`}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-muted/40"
            >
              <span className="min-w-0 truncate font-medium">
                {truncate(row.topic, 120)}
              </span>
              <TaskStatusBadge status={row.status} />
              <span className="justify-self-end font-mono text-xs text-muted-foreground">
                {formatCostUsd(row.cost_usd)}
              </span>
              <span className="justify-self-end text-xs text-muted-foreground">
                {formatRelativeTime(row.created_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
