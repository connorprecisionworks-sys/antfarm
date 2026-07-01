-- Antfarm engine queue — repo registry (repo picker)
-- The poller scans your machine for git repos and upserts them here so the
-- console can show a dropdown. Read-only to the public client; the poller
-- (service_role) does the writing.
-- Rollback: engine-queue/sql/003_repos_rollback.sql

create table if not exists public.repos (
  name       text primary key,
  path       text not null,
  label      text not null,
  updated_at timestamptz not null default now()
);

alter table public.repos enable row level security;

create policy "read repos" on public.repos
  for select
  to anon, authenticated
  using (true);
