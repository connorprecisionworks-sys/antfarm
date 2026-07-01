-- Antfarm engine queue — jobs table (Phase 3a)
-- Run in the SQL editor of the NEW dedicated antfarm Supabase project.
-- Rollback: engine-queue/sql/001_jobs_rollback.sql

create extension if not exists pgcrypto;

create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  repo           text not null,
  kind           text not null check (kind in ('forge', 'spec', 'delegate')),
  task           text not null,
  agent          text,
  status         text not null default 'queued'
                   check (status in ('queued', 'running', 'done', 'needs_you', 'error', 'approved', 'pushed')),
  result_summary text,
  diff           text,
  commit_hash    text,
  reviewer_note  text,
  error          text,
  approved       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index jobs_status_created_idx on public.jobs (status, created_at);

-- keep updated_at fresh on every write
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row
  execute function public.set_updated_at();

-- Row Level Security: only authenticated users (Connor, via magic link) can touch jobs.
-- The Mac poller uses the service_role key, which bypasses RLS.
alter table public.jobs enable row level security;

create policy "authenticated full access to jobs"
  on public.jobs
  for all
  to authenticated
  using (true)
  with check (true);
