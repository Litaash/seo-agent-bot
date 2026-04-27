import {
  DEFAULT_MODEL,
  GEMINI_PRICING,
  getDailyBudgetUsd,
  getDailySpendUsd,
} from "@/lib/cost";
import {
  DEFAULT_TASK_BUDGET_USD,
  LOOP_REPEAT_THRESHOLD,
  MAX_STEPS,
  MAX_TOTAL_TOKENS,
  RUN_TIMEOUT_MS,
} from "@/lib/guardrails";
import { formatCostUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Read-only settings dashboard.
 *
 * MVP scope is single-owner with all configuration sourced from env
 * vars, so this page is a *transparency surface* — it shows the current
 * limits + which integrations are wired up, but doesn't let you mutate
 * anything from the browser. Editing knobs live in `.env.local` and
 * (for the runtime caps) in `lib/guardrails.ts`.
 *
 * The two pieces that are dynamic at request time:
 *   - Today's USD spend, read from `agent_runs`.
 *   - Whether the optional integrations (Telegram, Search Console,
 *     cron secret) have credentials configured. We never display the
 *     credentials themselves — only "configured / missing".
 */
export const dynamic = "force-dynamic";

interface IntegrationStatus {
  name: string;
  description: string;
  configured: boolean;
  envVars: ReadonlyArray<string>;
}

function checkEnv(...names: string[]): boolean {
  return names.every((n) => Boolean(process.env[n]?.trim()));
}

export default async function SettingsPage() {
  const limit = getDailyBudgetUsd();
  let spent = 0;
  let spendError: string | null = null;
  try {
    spent = await getDailySpendUsd();
  } catch (err) {
    spendError = err instanceof Error ? err.message : String(err);
  }
  const remaining = Math.max(0, limit - spent);
  const ratio = Math.min(1, spent / Math.max(limit, 1e-6));

  const integrations: IntegrationStatus[] = [
    {
      name: "Google Generative AI",
      description: "Used by every subagent and the orchestrator.",
      configured: checkEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
      envVars: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    },
    {
      name: "Supabase",
      description:
        "Stores tasks, agent steps, articles, and per-call cost rows.",
      configured: checkEnv(
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
      ),
      envVars: [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
      ],
    },
    {
      name: "Telegram",
      description: "Destination channel for the Approve & publish action.",
      configured: checkEnv("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"),
      envVars: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"],
    },
    {
      name: "Google Search Console",
      description:
        "Optional — drives the weekly cron that re-evaluates published articles.",
      configured: checkEnv("GSC_SITE_URL"),
      envVars: ["GSC_SITE_URL"],
    },
    {
      name: "Cron secret",
      description:
        "Shared bearer token Vercel Cron sends with the weekly check.",
      configured: checkEnv("CRON_SECRET"),
      envVars: ["CRON_SECRET"],
    },
  ];

  const pricing = GEMINI_PRICING[DEFAULT_MODEL];

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only view of the runtime configuration. To change a value,
          edit <code>.env.local</code> (for secrets) or{" "}
          <code>lib/guardrails.ts</code> (for the agent caps) and redeploy.
        </p>
      </header>

      {/* ---- Daily LLM budget ---------------------------------------- */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-heading text-base font-semibold">
            Daily LLM budget
          </h2>
          <span className="text-xs text-muted-foreground">
            resets at UTC midnight
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Spent today" value={formatCostUsd(spent)} />
          <Stat label="Daily cap" value={formatCostUsd(limit)} />
          <Stat
            label="Remaining"
            value={formatCostUsd(remaining)}
            tone={remaining <= 0 ? "destructive" : undefined}
          />
        </div>
        <BudgetBar ratio={ratio} />
        <p className="text-xs text-muted-foreground">
          Set <code>DAILY_BUDGET_USD</code> in <code>.env.local</code> to
          change the cap. Today&apos;s spend is the sum of{" "}
          <code>agent_runs.cost_usd</code> for the current UTC day.
        </p>
        {spendError && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            Failed to read daily spend: {spendError}
          </p>
        )}
      </section>

      {/* ---- Per-run guardrails -------------------------------------- */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
        <h2 className="font-heading text-base font-semibold">
          Per-run guardrails
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Max steps" value={String(MAX_STEPS)} />
          <Stat
            label="Max tokens"
            value={MAX_TOTAL_TOKENS.toLocaleString()}
          />
          <Stat
            label="Loop threshold"
            value={`${LOOP_REPEAT_THRESHOLD}× (tool, args)`}
          />
          <Stat
            label="Run timeout"
            value={`${Math.round(RUN_TIMEOUT_MS / 1000)}s`}
          />
          <Stat
            label="Default task cap"
            value={formatCostUsd(DEFAULT_TASK_BUDGET_USD)}
          />
          <Stat
            label="Default model"
            value={DEFAULT_MODEL}
            mono
          />
          <Stat
            label="Input price"
            value={`${formatCostUsd(pricing.input)}/M tok`}
            mono
          />
          <Stat
            label="Output price"
            value={`${formatCostUsd(pricing.output)}/M tok`}
            mono
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Five defenses stack: step-count cap, token cap, loop detection,
          per-task cost cap, and a wall-clock timeout. The orchestrator
          also pre-checks the daily budget before starting.
        </p>
      </section>

      {/* ---- Integrations --------------------------------------------- */}
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
        <h2 className="font-heading text-base font-semibold">Integrations</h2>
        <ul className="divide-y">
          {integrations.map((integration) => (
            <li
              key={integration.name}
              className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{integration.name}</span>
                  <StatusPill configured={integration.configured} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {integration.description}
              </p>
              <div className="flex flex-wrap gap-1">
                {integration.envVars.map((v) => (
                  <code
                    key={v}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {v}
                  </code>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: "destructive";
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-background p-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-base font-semibold",
          mono && "font-mono text-sm",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function BudgetBar({ ratio }: { ratio: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const tone =
    pct >= 100
      ? "bg-destructive"
      : pct >= 75
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all", tone)}
        style={{ width: `${pct}%` }}
        aria-label={`Daily budget used: ${pct}%`}
      />
    </div>
  );
}

function StatusPill({ configured }: { configured: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
        configured
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {configured ? "configured" : "missing"}
    </span>
  );
}
