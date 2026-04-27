-- 0001_init.sql
-- SEO Agent Bot — initial schema
-- Tables: tasks, agent_steps, articles, agent_runs
-- Note: dashboard is single-owner (no auth in MVP). All writes happen
-- server-side via the service_role key. RLS is enabled on every table
-- as defense-in-depth so the anon/publishable key cannot read/write.

create extension if not exists "pgcrypto";

------------------------------------------------------------
-- tasks
------------------------------------------------------------
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  topic        text not null,
  status       text not null default 'pending',
  cost_usd     numeric(10, 6) default 0,
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  constraint tasks_status_check check (
    status in ('pending', 'running', 'awaiting_approval', 'published', 'failed')
  )
);

create index if not exists tasks_status_created_at_idx
  on public.tasks (status, created_at desc);

------------------------------------------------------------
-- agent_steps (live-stream of orchestrator events)
------------------------------------------------------------
create table if not exists public.agent_steps (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  step_type    text,
  content      jsonb,
  tokens_in    int default 0,
  tokens_out   int default 0,
  cost_usd     numeric(10, 6) default 0,
  created_at   timestamptz not null default now(),
  constraint agent_steps_step_type_check check (
    step_type is null
    or step_type in ('think', 'tool_call', 'tool_result', 'content', 'error')
  )
);

create index if not exists agent_steps_task_id_created_at_idx
  on public.agent_steps (task_id, created_at);

------------------------------------------------------------
-- articles (drafts + post-publish GSC metrics)
------------------------------------------------------------
create table if not exists public.articles (
  id                   uuid primary key default gen_random_uuid(),
  task_id              uuid references public.tasks (id) on delete set null,
  title                text not null,
  content_md           text not null,
  keywords             text[],
  telegram_message_id  bigint,
  published_at         timestamptz,
  gsc_position         numeric,
  gsc_clicks           int default 0,
  gsc_impressions      int default 0,
  last_checked_at      timestamptz
);

create index if not exists articles_task_id_idx
  on public.articles (task_id);

create index if not exists articles_published_at_idx
  on public.articles (published_at)
  where published_at is not null;

------------------------------------------------------------
-- agent_runs (per-LLM-call cost tracking)
------------------------------------------------------------
create table if not exists public.agent_runs (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references public.tasks (id) on delete cascade,
  model           text,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(10, 6),
  created_at      timestamptz not null default now()
);

create index if not exists agent_runs_task_id_created_at_idx
  on public.agent_runs (task_id, created_at desc);

create index if not exists agent_runs_created_at_idx
  on public.agent_runs (created_at desc);

------------------------------------------------------------
-- RLS — defense-in-depth.
-- All access is server-side via SUPABASE_SERVICE_ROLE_KEY which bypasses
-- RLS. Without policies, anon/authenticated roles cannot see/modify rows.
------------------------------------------------------------
alter table public.tasks       enable row level security;
alter table public.agent_steps enable row level security;
alter table public.articles    enable row level security;
alter table public.agent_runs  enable row level security;
