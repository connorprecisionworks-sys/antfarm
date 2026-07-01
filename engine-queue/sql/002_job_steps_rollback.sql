-- Rollback for 002_job_steps.sql

alter table public.jobs drop column if exists steps;
alter table public.jobs drop column if exists current_phase;
