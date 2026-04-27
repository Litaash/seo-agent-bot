import {
  getDailyBudgetUsd,
  getDailySpendUsd,
} from "@/lib/cost";
import { formatCostUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Compact "spent / budget" pill rendered in the dashboard header.
 *
 * Reads today's cumulative `agent_runs` cost on the server. If the daily
 * spend isn't reachable (e.g. Supabase outage), we render a neutral
 * "budget unknown" pill instead of throwing — header rendering must not
 * gate the rest of the dashboard from being usable.
 */
export async function DailyBudgetMeter() {
  const limit = getDailyBudgetUsd();
  let spent = 0;
  let ok = true;
  try {
    spent = await getDailySpendUsd();
  } catch {
    ok = false;
  }

  if (!ok) {
    return (
      <span className="hidden text-xs text-muted-foreground sm:inline">
        Budget · —
      </span>
    );
  }

  const ratio = Math.min(1, spent / Math.max(limit, 1e-6));
  const tone =
    ratio >= 1
      ? "text-destructive"
      : ratio >= 0.75
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  return (
    <span
      className={cn(
        "hidden items-center gap-2 rounded-full border px-3 py-1 text-xs sm:inline-flex",
        tone,
      )}
      title={`Today's LLM spend across all runs (resets at UTC midnight).`}
    >
      <span className="font-medium">{formatCostUsd(spent)}</span>
      <span className="opacity-60">/</span>
      <span>{formatCostUsd(limit)}</span>
    </span>
  );
}
