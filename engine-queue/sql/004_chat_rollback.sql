-- Rollback for 004_chat.sql

alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
  add constraint jobs_kind_check
  check (kind in ('forge', 'spec', 'delegate'));

drop policy if exists "open access to messages" on public.messages;
drop table if exists public.messages;
