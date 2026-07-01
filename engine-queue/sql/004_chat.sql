-- Antfarm engine queue — chat memory (Agents tab)
-- Adds a messages table for short-lived per-agent chat history and allows
-- the 'chat' job kind so the poller can route conversational turns through
-- `delegate`.
-- Rollback: engine-queue/sql/004_chat_rollback.sql

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  agent      text not null,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index messages_agent_created_idx on public.messages (agent, created_at);

alter table public.messages enable row level security;

create policy "open access to messages"
  on public.messages
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- Allow the new 'chat' job kind.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
  add constraint jobs_kind_check
  check (kind in ('forge', 'spec', 'delegate', 'chat'));
