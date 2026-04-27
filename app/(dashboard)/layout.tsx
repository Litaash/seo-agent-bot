import Link from "next/link";

import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { DailyBudgetMeter } from "@/components/dashboard/daily-budget-meter";

/**
 * Layout shared by every dashboard route. Provides the top header with
 * navigation + a live daily-budget meter so the operator always knows
 * how much of today's $1 cap has been consumed before launching another
 * run. The meter reads its data on the server (via the `agent_runs`
 * table) so it doesn't require auth on the browser.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link
            href="/"
            className="font-heading text-base font-semibold tracking-tight"
          >
            SEO Agent Bot
          </Link>
          <DashboardNav />
          <DailyBudgetMeter />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
      <footer className="border-t">
        <div className="mx-auto w-full max-w-6xl px-6 py-4 text-xs text-muted-foreground">
          Single-owner MVP — runs gated by a $1/day LLM budget.
        </div>
      </footer>
    </div>
  );
}
