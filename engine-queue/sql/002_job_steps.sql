-- Antfarm engine queue — live step narration fields (glow-up rung A)
-- Adds a steps log and a current_phase so the poller can stream plain-English
-- progress (Plan/Build/Review/Done) into the phone console as a job runs.
-- Rollback: engine-queue/sql/002_job_steps_rollback.sql

alter table public.jobs
  add column if not exists steps jsonb not null default '[]'::jsonb,
  add column if not exists current_phase text;
