-- Rollback for 001_jobs.sql — drops the antfarm jobs table and its trigger function.
-- Run in the SQL editor of the antfarm Supabase project to fully undo Phase 3a.

drop trigger if exists jobs_set_updated_at on public.jobs;
drop table if exists public.jobs;
drop function if exists public.set_updated_at();
