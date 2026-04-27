/**
 * Pure formatting helpers used across the dashboard. Kept framework-free
 * (no React, no `server-only`) so they can be imported from both Server
 * and Client Components.
 */

/** Project-wide canonical task statuses. Mirrors the SQL CHECK constraint. */
export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "published"
  | "failed";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  published: "Published",
  failed: "Failed",
};

/**
 * Display label for any string status. Unknown statuses fall back to
 * the raw string so a future migration adding a state shows up sensibly
 * instead of silently rendering as "Unknown".
 */
export function formatTaskStatus(status: string): string {
  return TASK_STATUS_LABEL[status as TaskStatus] ?? status;
}

/**
 * Map a status to a Tailwind variant class. We don't reach for the
 * shadcn Badge variants here because we want a few extra dashboard-only
 * tones (e.g. amber for "awaiting approval") that the badge lib lacks.
 */
export function taskStatusBadgeClass(status: string): string {
  switch (status as TaskStatus) {
    case "pending":
      return "bg-muted text-muted-foreground";
    case "running":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-300";
    case "awaiting_approval":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "published":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * Format a USD cost to a budget-aware precision: sub-cent costs get four
 * decimals so they aren't all rounded to "$0.00", everything else falls
 * back to the standard cent precision.
 */
export function formatCostUsd(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Compact relative time formatter ("just now", "4m ago", "2h ago",
 * "3d ago", or an ISO date for anything older than a week). Avoids
 * pulling in a date-fns dependency for one routine call site.
 */
export function formatRelativeTime(
  iso: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = now.getTime() - date.getTime();
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 0) return "just now";
  if (diffS < 30) return "just now";
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return date.toISOString().slice(0, 10);
}

/** Truncate a string to `max` characters, suffixing with `…`. */
export function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
